import { query } from "@anthropic-ai/claude-agent-sdk";
import http from "node:http";
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execSync } from "node:child_process";

// ── Config ───────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || "/home/sandbox";
const SANDBOX = join(HOME, "sandbox");
const PORT = parseInt(process.env.PORT || "3000");
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2");
const TASKS_FILE = join(SANDBOX, "shared", "TASKS.json");

mkdirSync(join(SANDBOX, "shared"), { recursive: true });
mkdirSync(join(SANDBOX, "logs"), { recursive: true });

const AGENTS = {
  coordinator: {
    workspace: join(SANDBOX, "agents/coordinator"),
    role: "Orchestrator — routes tasks, monitors agents, escalates issues",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  },
  analyst: {
    workspace: join(SANDBOX, "agents/analyst"),
    role: "Data analyst — processes data, finds patterns, statistical analysis",
    allowedTools: ["Read", "Write", "Bash", "Glob", "Grep"],
  },
  researcher: {
    workspace: join(SANDBOX, "agents/researcher"),
    role: "Researcher — reads files, summarizes, cross-references information",
    allowedTools: ["Read", "Glob", "Grep"],
  },
  builder: {
    workspace: join(SANDBOX, "agents/builder"),
    role: "Builder — writes code, scripts, generates structured outputs",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  },
  auditor: {
    workspace: join(SANDBOX, "agents/auditor"),
    role: "Auditor — reviews other agents' work, catches errors, quality control",
    allowedTools: ["Read", "Glob", "Grep"],
  },
  stresstester: {
    workspace: join(SANDBOX, "agents/stresstester"),
    role: "Stress Tester — chaos/QA, finds weaknesses, documents what breaks",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  },
  medic: {
    workspace: join(SANDBOX, "agents/medic"),
    role: "Medic — self-healing, monitors health, fixes broken agents/tasks",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  },
};

// ── State ────────────────────────────────────────────────────────────────────
let activeJobs = 0;
const jobQueue = [];

// ── Helpers ──────────────────────────────────────────────────────────────────
function localDateTime() {
  const now = new Date();
  return { date: now.toLocaleDateString("en-CA"), time: now.toLocaleTimeString("en-GB", { hour12: false }), iso: now.toISOString() };
}

function logSandbox(message) {
  const { date, time } = localDateTime();
  appendFileSync(join(SANDBOX, "logs", `sandbox-${date}.log`), `[${time}] ${message}\n`);
  console.log(`[${time}] ${message}`);
}

function logToMemory(agentName, message) {
  const { date, time } = localDateTime();
  const memDir = join(AGENTS[agentName]?.workspace || SANDBOX, "memory");
  mkdirSync(memDir, { recursive: true });
  const file = join(memDir, `${date}.md`);
  if (!existsSync(file)) writeFileSync(file, `# ${date} — ${agentName} Daily Log\n\n`);
  appendFileSync(file, `- [${time}] ${message}\n`);
}

// ── Task System ──────────────────────────────────────────────────────────────
function loadTasks() { try { return JSON.parse(readFileSync(TASKS_FILE, "utf-8")); } catch { return []; } }
function saveTasks(tasks) { writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); }

function createTask({ agent, prompt, source, mode, agents: agentList, messages }) {
  const tasks = loadTasks();
  const { date, iso } = localDateTime();
  const id = `SAND-${date.replace(/-/g, "")}-${String(tasks.length + 1).padStart(3, "0")}`;
  const task = {
    id, agent, prompt, source: source || "api",
    status: mode === "conversation" ? "active" : "pending",
    mode: mode || "task",
    agents: agentList || [agent],
    messages: messages || [{ role: "user", content: prompt, ts: iso }],
    created: iso, completed: null, result: null, error: null,
  };
  tasks.push(task);
  saveTasks(tasks);
  logSandbox(`[${agent}] Task created: ${id} (mode: ${task.mode})`);
  return task;
}

function updateTask(taskId, updates) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates);
  saveTasks(tasks);
  return tasks[idx];
}

// ── SDK Agent Runner ─────────────────────────────────────────────────────────
async function runAgent(agentName, prompt, { onStream } = {}) {
  const agent = AGENTS[agentName];
  if (!agent) throw new Error(`Unknown agent: ${agentName}`);

  const claudeMdPath = join(agent.workspace, "CLAUDE.md");
  let context = "";
  if (existsSync(claudeMdPath)) context = readFileSync(claudeMdPath, "utf8") + "\n\n";

  const fullPrompt = context ? `<context>\n${context}</context>\n\n${prompt}` : prompt;

  const startTime = Date.now();
  let resultText = "";
  let sessionId = null;
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastStreamUpdate = 0;

  for await (const message of query({
    prompt: fullPrompt,
    options: {
      allowedTools: agent.allowedTools,
      permissionMode: "bypassPermissions",
      cwd: agent.workspace,
      model: "sonnet",
    }
  })) {
    // Stream partial results on every assistant message
    if (message.type === "assistant" && message.message?.content && onStream) {
      const contentParts = message.message.content;
      const thinking = contentParts.filter(c => c.type === "thinking").map(c => c.thinking).join("");
      const text = contentParts.filter(c => c.type === "text").map(c => c.text).join("");
      if (text) {
        onStream(text);
      } else if (thinking) {
        onStream("💭 " + thinking.substring(0, 300) + "...");
      }
    }
    // Show tool use activity
    if (message.type === "assistant" && message.message?.content && onStream) {
      const tools = message.message.content.filter(c => c.type === "tool_use");
      if (tools.length) {
        const toolNames = tools.map(t => t.name).join(", ");
        onStream("🔧 Using: " + toolNames + "...");
      }
    }
    // Show tool results
    if (message.type === "user" && message.message?.content && onStream) {
      const results = (Array.isArray(message.message.content) ? message.message.content : []).filter(c => c.type === "tool_result");
      if (results.length) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        onStream("⚙️ Working... (" + elapsed + "s)");
      }
    }
    if (message.type === "result") {
      resultText = message.result || "";
      totalCost = message.total_cost_usd || 0;
      sessionId = message.session_id || null;
      if (message.usage) {
        inputTokens = message.usage.input_tokens || 0;
        outputTokens = message.usage.output_tokens || 0;
      }
    }
  }

  const duration = Date.now() - startTime;

  // Log to memory
  logToMemory(agentName, `Task complete (${duration}ms, ${inputTokens + outputTokens} tokens): ${prompt.substring(0, 100)}`);

  // Log interaction
  const { date, iso } = localDateTime();
  const interLog = join(SANDBOX, "logs", "interactions");
  mkdirSync(interLog, { recursive: true });
  appendFileSync(join(interLog, `${date}.jsonl`), JSON.stringify({
    ts: iso, agent: agentName, prompt: prompt.substring(0, 5000), response: resultText.substring(0, 10000),
    tokens_in: inputTokens, tokens_out: outputTokens, duration_ms: duration, session_id: sessionId,
  }) + "\n");

  return { result: resultText, session_id: sessionId, duration_ms: duration, tokens: { input: inputTokens, output: outputTokens } };
}

// ── Job Queue ────────────────────────────────────────────────────────────────
async function processJob(job) {
  activeJobs++;
  const { agent, prompt, resolve, reject, onStream } = job;
  logSandbox(`[${agent}] Starting job (${activeJobs} active)`);

  try {
    const result = await runAgent(agent, prompt, { onStream });
    logSandbox(`[${agent}] Job complete (${result.result.length} chars, ${result.duration_ms}ms)`);
    if (resolve) resolve(result);
  } catch (err) {
    logSandbox(`[${agent}] Job failed: ${err.message}`);
    logToMemory(agent, `Task FAILED: ${err.message.substring(0, 200)}`);
    if (reject) reject(err);
  } finally {
    activeJobs--;
    while (jobQueue.length > 0 && activeJobs < MAX_CONCURRENT) {
      processJob(jobQueue.shift());
    }
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, cors);
    // Detect model from gpu_server /props or /v1/models
    let modelName = "local-model";
    try { const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/models", { signal: AbortSignal.timeout(2000) }); const d = await r.json(); modelName = (d.models?.[0]?.name || d.data?.[0]?.id || "").replace(".gguf","") || "local-model"; } catch {}
    res.end(JSON.stringify({ status: "ok", runtime: "sandbox-sdk", model: modelName, agents: Object.keys(AGENTS), activeJobs, queueDepth: jobQueue.length }));
    return;
  }

  if (req.method === "GET" && req.url === "/api/tasks") {
    res.writeHead(200, cors);
    res.end(JSON.stringify(loadTasks()));
    return;
  }

  // Spawn agent
  if (req.method === "POST" && req.url.startsWith("/spawn/")) {
    const agentName = req.url.split("/spawn/")[1];
    if (!AGENTS[agentName]) { res.writeHead(404, cors); res.end(JSON.stringify({ error: `Unknown agent: ${agentName}` })); return; }

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { task: taskPrompt, source: taskSource } = payload;
    if (!taskPrompt || taskPrompt.trim().length < 3) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "task prompt is required (min 3 chars)" })); return; }

    const task = createTask({ agent: agentName, prompt: taskPrompt, source: taskSource || "spawn" });

    try {
      const result = await new Promise((resolve, reject) => {
        const job = { agent: agentName, prompt: taskPrompt, resolve, reject };
        if (activeJobs < MAX_CONCURRENT) processJob(job);
        else jobQueue.push(job);
      });

      // Detect files created by the agent
      const responseText = result.result || "";
      const fileRefs = responseText.match(/(?:~\/sandbox|\/home\/sandbox_vm\/sandbox)\/[^\s\n)]+/g) || [];
      const attachedFiles = [];
      for (const ref of fileRefs) {
        const fpath = ref.replace("~/sandbox", join(HOME, "sandbox"));
        if (existsSync(fpath) && require("fs").statSync(fpath).isFile()) {
          if (/\.(md|txt|py|json|csv|html|js|sh|log|yml|yaml|xml|sql)$/i.test(fpath)) {
            attachedFiles.push({ name: fpath.split("/").pop(), path: ref, content: readFileSync(fpath, "utf-8").substring(0, 20000) });
          } else {
            attachedFiles.push({ name: fpath.split("/").pop(), path: ref, size: require("fs").statSync(fpath).size });
          }
        }
      }

      // Store result with files if task has messages
      const taskData = loadTasks().find(t => t.id === task.id);
      if (taskData?.messages) {
        taskData.messages.push({ role: "agent", agent: agentName, content: responseText, ts: localDateTime().iso, files: attachedFiles.length ? attachedFiles : undefined });
        updateTask(task.id, { status: "completed", completed: localDateTime().iso, result: responseText.substring(0, 2000), messages: taskData.messages });
      } else {
        updateTask(task.id, { status: "completed", completed: localDateTime().iso, result: responseText.substring(0, 2000), files: attachedFiles.length ? attachedFiles : undefined });
      }

      res.writeHead(200, cors);
      res.end(JSON.stringify({ agent: agentName, status: "complete", taskId: task.id, result: result.result, tokens: result.tokens, duration_ms: result.duration_ms, files: attachedFiles }));
    } catch (err) {
      updateTask(task.id, { status: "failed", error: err.message });
      res.writeHead(500, cors);
      res.end(JSON.stringify({ agent: agentName, status: "error", error: err.message }));
    }
    return;
  }

  // Agent memories
  if (req.method === "GET" && req.url === "/api/memories") {
    const { date } = localDateTime();
    const memories = {};
    for (const [name, agent] of Object.entries(AGENTS)) {
      const memFile = join(agent.workspace, "memory", `${date}.md`);
      memories[name] = existsSync(memFile) ? readFileSync(memFile, "utf-8") : "";
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify({ date, memories }));
    return;
  }

  // Interactions
  if (req.method === "GET" && req.url.startsWith("/api/interactions")) {
    const { date } = localDateTime();
    const logFile = join(SANDBOX, "logs", "interactions", `${date}.jsonl`);
    let entries = [];
    if (existsSync(logFile)) {
      entries = readFileSync(logFile, "utf-8").split("\n").filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify({ date, entries, total: entries.length }));
    return;
  }

  // ── Conversation message with @mention pipeline + rounds ──
  if (req.method === "POST" && req.url.match(/^\/api\/tasks\/[^/]+\/message$/)) {
    const taskId = req.url.split("/api/tasks/")[1].replace("/message", "");

    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { message, rounds: requestedRounds, skipUserMsg } = payload;
    if (!message || message.trim().length < 3) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "message required (min 3 chars)" })); return; }

    const tasks = loadTasks();
    let task = tasks.find(t => t.id === taskId);
    if (!task) {
      task = { id: taskId, mode: "conversation", agent: "coordinator", agents: [], messages: [], status: "active", created: localDateTime().iso };
      tasks.push(task);
      saveTasks(tasks);
    }
    if (task.mode !== "conversation") {
      task.mode = "conversation";
      if (!task.agents) task.agents = [task.agent];
      if (!task.messages) task.messages = [];
    }

    // Parse rounds
    const COST_CAP_SECONDS = 600; // 10 min total cap
    const MAX_ROUNDS = 5;
    const roundsMatch = message.match(/\[rounds?:?\s*(\d+)\]/i);
    const rounds = Math.min(parseInt(roundsMatch?.[1] || requestedRounds || "1") || 1, MAX_ROUNDS);

    // Format instructions for output types
    const FORMAT_INSTRUCTIONS = {
      xlsx: "Save results as an Excel file (.xlsx) in your reports/ directory using Python (openpyxl or pandas). Install if needed: pip install openpyxl pandas.",
      csv: "Save results as a CSV file in your reports/ directory.",
      pdf: "Save results as a PDF in your reports/ directory using Python (fpdf2). Install if needed: pip install fpdf2.",
      md: "Save results as a Markdown file (.md) in your reports/ directory.",
      json: "Save results as a formatted JSON file in your reports/ directory.",
      py: "Save results as a Python script (.py) in your reports/ directory. Include docstrings and make it runnable.",
      html: "Save results as a standalone HTML file in your reports/ directory with inline CSS.",
      txt: "Save results as a plain text file in your reports/ directory.",
    };

    // Parse ALL @mentions with optional [format]
    const agentIds = Object.keys(AGENTS).join("|");
    const mentionRegex = new RegExp(`@(${agentIds})(?:\\s*\\[(\\w+)\\])?`, "gi");
    const allMentions = [...message.matchAll(mentionRegex)].map(m => ({ agent: m[1].toLowerCase(), format: m[2]?.toLowerCase() || null }));
    const seen = new Set();
    const pipelineWithFormats = [];
    for (const m of allMentions) {
      if (!seen.has(m.agent)) { seen.add(m.agent); pipelineWithFormats.push(m); }
    }
    if (pipelineWithFormats.length === 0) {
      const lastAgent = [...(task.messages || [])].reverse().find(m => m.role === "agent" && m.agent)?.agent || task.agent;
      pipelineWithFormats.push({ agent: lastAgent, format: null });
    }
    const pipeline = pipelineWithFormats.map(p => p.agent);

    // Auto-add agents
    if (!task.agents) task.agents = [task.agent];
    for (const a of pipeline) {
      if (!task.agents.includes(a)) task.agents.push(a);
    }

    // Add user message (skip if already added by createTask)
    const { iso } = localDateTime();
    if (!skipUserMsg) task.messages.push({ role: "user", content: message, ts: iso });
    updateTask(taskId, { messages: task.messages, status: "in_progress", agent: pipeline[0] });

    logSandbox(`[${taskId}] Pipeline: ${pipeline.join(" → ")} × ${rounds} rounds`);

    // Return immediately — run pipeline in background
    res.writeHead(200, cors);
    res.end(JSON.stringify({ status: "accepted", taskId, pipeline, rounds }));

    // Background pipeline execution
    (async () => {
      const SKIP_PATTERNS = /\b(agreed|nothing to add|looks good|no changes|lgtm|all good)\b/i;
      const responses = [];
      const skippedAgents = new Set();
      const startTime = Date.now();

      try {
        for (let round = 1; round <= rounds; round++) {
          if (rounds > 1) {
            task.messages.push({ role: "system", content: `── Round ${round} of ${rounds} ──`, ts: localDateTime().iso });
            updateTask(taskId, { messages: task.messages });
          }

          for (const agent of pipeline) {
            if (skippedAgents.has(agent)) continue;
            if (Date.now() - startTime > COST_CAP_SECONDS * 1000) {
              task.messages.push({ role: "system", content: `Time cap reached. Stopping.`, ts: localDateTime().iso });
              updateTask(taskId, { messages: task.messages });
              break;
            }

            // Build context with smart management
            let parts = [`You are "${agent}" in a multi-agent conversation. Agents: ${(task.agents || []).join(", ")}.`];
            if (rounds > 1) {
              parts.push(`Round ${round} of ${rounds}.`);
              if (round > 1) parts.push(`Review prior rounds. If you agree, just say "agreed".`);
            }
            if (pipeline.length > 1) {
              const myIdx = pipeline.indexOf(agent);
              if (myIdx === pipeline.length - 1 && round === 1) parts.push(`You are the FINAL agent. Synthesize what others said.`);
            }

            // Smart context management — keep full recent context, summarize old
            const MAX_CONTEXT_CHARS = 40000;
            const msgs = task.messages.filter(m => !m.streaming);
            let convText = "";
            let summarized = false;

            // Always include user messages in full
            const userMsgs = msgs.filter(m => m.role === "user");
            const agentMsgs = msgs.filter(m => m.role === "agent" || m.role === "system");

            // Build full conversation text to check size
            let fullConv = msgs.map(m => {
              if (m.role === "user") return `\nUSER: ${m.content}`;
              if (m.role === "system") return `\nSYSTEM: ${m.content}`;
              return `\n${(m.agent || "agent").toUpperCase()}: ${m.content}`;
            }).join("");

            if (fullConv.length > MAX_CONTEXT_CHARS) {
              // Summarize: keep first user message + last round in full, compress middle
              summarized = true;
              const firstUser = userMsgs[0];
              const lastRoundMsgs = msgs.filter(m => m.round === round - 1 || m.round === round || m.role === "user");
              const olderMsgs = msgs.filter(m => !lastRoundMsgs.includes(m) && m !== firstUser);

              // Compress older messages to key points
              const compressed = olderMsgs.map(m => {
                if (m.role === "system") return "";
                const content = (m.content || "").substring(0, 200);
                return `${(m.agent || "user").toUpperCase()}: ${content}...`;
              }).filter(Boolean).join("\n");

              parts.push(`\n[CONTEXT SUMMARY — earlier messages condensed to save space]`);
              parts.push(`Original request: ${firstUser?.content || ""}`);
              if (compressed) parts.push(`\nPrior discussion (condensed):\n${compressed}`);
              parts.push(`\n[FULL RECENT CONTEXT]`);
              for (const m of lastRoundMsgs) {
                if (m.role === "user") parts.push(`\nUSER: ${m.content}`);
                else if (m.role === "system") parts.push(`\nSYSTEM: ${m.content}`);
                else parts.push(`\n${(m.agent || "agent").toUpperCase()}: ${m.content}`);
              }
            } else {
              parts.push(`\nConversation:`);
              parts.push(fullConv);
            }

            // Per-agent format instructions
            const agentFormat = pipelineWithFormats.find(p => p.agent === agent)?.format;
            if (agentFormat && FORMAT_INSTRUCTIONS[agentFormat]) {
              parts.push(`\nOUTPUT FORMAT: ${FORMAT_INSTRUCTIONS[agentFormat]}`);
              parts.push(`After saving the file, state the full path clearly.`);
            }
            parts.push(`\nYou are ${agent}. Respond concisely.`);
            if (summarized) logSandbox(`[${agent}] Context compressed for round ${round} (was ${fullConv.length} chars)`);

            // Add streaming placeholder message
            const streamIdx = task.messages.length;
            task.messages.push({ role: "agent", agent, content: "⏳ thinking...", ts: localDateTime().iso, round, streaming: true });
            updateTask(taskId, { messages: task.messages, status: "in_progress", agent });

            // Run with error resilience — don't kill pipeline on single agent failure
            let result;
            try {
              result = await new Promise((resolve, reject) => {
                const job = {
                  agent, prompt: parts.join("\n"), resolve,
                  reject: (err) => reject(err),
                  onStream: (partial) => {
                    task.messages[streamIdx].content = partial + " ▌";
                    updateTask(taskId, { messages: task.messages });
                  }
                };
                // 10 minute timeout per agent (large files need more time)
                const timeout = setTimeout(() => reject(new Error("Agent timeout (10min)")), 600000);
                const origResolve = job.resolve;
                job.resolve = (r) => { clearTimeout(timeout); origResolve(r); };
                if (activeJobs < MAX_CONCURRENT) processJob(job);
                else jobQueue.push(job);
              });
            } catch (agentErr) {
              // Agent failed — log it and continue pipeline
              logSandbox(`[${agent}] Failed in pipeline: ${agentErr.message} — skipping`);
              task.messages[streamIdx] = { role: "error", agent, content: `Agent failed: ${agentErr.message}`, ts: localDateTime().iso, round };
              updateTask(taskId, { messages: task.messages });
              continue; // Skip to next agent in pipeline
            }

            const responseText = result.result?.substring(0, 10000) || "";
            if (round > 1 && SKIP_PATTERNS.test(responseText) && responseText.length < 200) {
              skippedAgents.add(agent);
            }

            // Detect files created/mentioned and attach content
            const fileRefs = responseText.match(/(?:~\/sandbox|\/home\/sandbox_vm\/sandbox)\/[^\s\n)]+/g) || [];
            const attachedFiles = [];
            for (const ref of fileRefs) {
              const fpath = ref.replace("~/sandbox", join(HOME, "sandbox"));
              if (existsSync(fpath) && require("fs").statSync(fpath).isFile()) {
                const size = require("fs").statSync(fpath).size;
                if (/\.(md|txt|py|json|csv|html|js|sh|log|yml|yaml|xml|sql|r|ipynb|tsx|ts|jsx|css|toml|ini|cfg|env)$/i.test(fpath)) {
                  attachedFiles.push({ name: fpath.split("/").pop(), path: ref, content: readFileSync(fpath, "utf-8").substring(0, 20000) });
                } else {
                  attachedFiles.push({ name: fpath.split("/").pop(), path: ref, size });
                }
              }
            }

            // Replace streaming placeholder with final response
            task.messages[streamIdx] = { role: "agent", agent, content: responseText, ts: localDateTime().iso, round, files: attachedFiles.length ? attachedFiles : undefined };
            updateTask(taskId, { messages: task.messages, status: "in_progress", agent });
            responses.push({ agent, response: responseText, round });
          }
        }

        updateTask(taskId, { messages: task.messages, status: "active", lastActivity: localDateTime().iso });
      } catch (err) {
        task.messages.push({ role: "error", content: err.message, ts: localDateTime().iso });
        updateTask(taskId, { messages: task.messages, status: "active" });
      }
    })();
    return;
  }

  // ── Create conversation task ──
  if (req.method === "POST" && req.url === "/api/tasks/create") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }

    const { agent, description, mode, agents: agentList, rounds } = payload;
    if (!agent || !description) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "agent and description required" })); return; }

    const task = createTask({ agent, prompt: description, source: "user", mode: mode || "task", agents: agentList });
    res.writeHead(200, cors);
    res.end(JSON.stringify(task));

    // If conversation, send first message to pipeline (message already in task.messages from createTask)
    if (mode === "conversation") {
      (async () => {
        try {
          // Skip adding user message again — already in task from createTask
          const msgPayload = JSON.stringify({ message: description, rounds: rounds || 1, skipUserMsg: true });
          await fetch(`http://localhost:${PORT}/api/tasks/${task.id}/message`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: msgPayload,
            signal: AbortSignal.timeout(600000),
          });
        } catch (e) { logSandbox(`[${task.id}] Conversation start failed: ${e.message}`); }
      })();
    }
    return;
  }

  // ── Task cleanup — kill stale tasks, clear queue ──
  if (req.method === "POST" && req.url === "/api/tasks/cleanup") {
    const tasks = loadTasks();
    const now = Date.now();
    let killed = 0;
    let cleared = 0;
    for (const t of tasks) {
      // Kill tasks stuck in_progress for more than 10 min
      if (t.status === "in_progress" && t.created) {
        const age = now - new Date(t.created).getTime();
        if (age > 600000) {
          t.status = "failed";
          t.error = "Killed by cleanup (stuck >10min)";
          killed++;
        }
      }
      // Kill pending tasks older than 30 min (stale queue)
      if (t.status === "pending" && t.created) {
        const age = now - new Date(t.created).getTime();
        if (age > 1800000) {
          t.status = "failed";
          t.error = "Expired from queue (>30min pending)";
          cleared++;
        }
      }
    }
    saveTasks(tasks);
    // Clear in-memory job queue too
    const queueCleared = jobQueue.length;
    jobQueue.length = 0;
    logSandbox(`Cleanup: ${killed} stuck killed, ${cleared} expired cleared, ${queueCleared} queue flushed`);
    res.writeHead(200, cors);
    res.end(JSON.stringify({ killed, cleared, queueFlushed: queueCleared }));
    return;
  }

  // ── Task stats ──
  if (req.method === "GET" && req.url === "/api/tasks/stats") {
    const tasks = loadTasks();
    const { date } = localDateTime();
    const today = tasks.filter(t => (t.created || "").startsWith(date));
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      total: tasks.length,
      today: today.length,
      pending: tasks.filter(t => t.status === "pending").length,
      in_progress: tasks.filter(t => t.status === "in_progress").length,
      completed: today.filter(t => t.status === "completed").length,
      failed: today.filter(t => t.status === "failed").length,
      queueDepth: jobQueue.length,
    }));
    return;
  }

  // ── Update task status ──
  if (req.method === "PUT" && req.url.match(/^\/api\/tasks\/SAND-/)) {
    const taskId = req.url.split("/api/tasks/")[1];
    let body = "";
    for await (const chunk of req) body += chunk;
    let updates;
    try { updates = JSON.parse(body); } catch { res.writeHead(400, cors); res.end(JSON.stringify({ error: "invalid json" })); return; }
    const allowed = ["status", "title", "agent", "agents"];
    const safe = {};
    for (const k of allowed) { if (updates[k] !== undefined) safe[k] = updates[k]; }
    const updated = updateTask(taskId, safe);
    res.writeHead(200, cors);
    res.end(JSON.stringify(updated || { error: "not found" }));
    return;
  }

  // Upload file to a conversation (attaches to shared, adds reference to message)
  if (req.method === "POST" && req.url.match(/^\/api\/tasks\/[^/]+\/upload$/)) {
    const taskId = req.url.split("/api/tasks/")[1].replace("/upload", "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "no boundary" })); return; }

    const boundary = boundaryMatch[1];
    const parts = body.toString("binary").split("--" + boundary);
    let filename = "upload";
    let fileData = null;

    for (const part of parts) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const headers = part.substring(0, headerEnd);
      const fnMatch = headers.match(/filename="([^"]+)"/);
      if (fnMatch) {
        filename = fnMatch[1];
        const dataStart = headerEnd + 4;
        const dataEnd = part.lastIndexOf("\r\n");
        fileData = Buffer.from(part.substring(dataStart, dataEnd), "binary");
      }
    }

    if (fileData) {
      const dest = join(SANDBOX, "shared", filename);
      writeFileSync(dest, fileData);

      // Add file reference to conversation
      const tasks = loadTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        if (!task.messages) task.messages = [];
        task.messages.push({ role: "user", content: `[Attached file: ${filename} (${fileData.length} bytes) at ~/sandbox/shared/${filename}]`, ts: localDateTime().iso, attachment: filename });
        saveTasks(tasks);
      }

      logSandbox(`File attached to ${taskId}: ${filename} (${fileData.length} bytes)`);
      res.writeHead(200, cors);
      res.end(JSON.stringify({ status: "uploaded", filename, size: fileData.length, taskId }));
    } else {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: "no file data" }));
    }
    return;
  }

  // List agent report files (outputs)
  if (req.method === "GET" && req.url.startsWith("/api/reports/")) {
    const agentName = req.url.split("/api/reports/")[1];
    const reportsDir = join(SANDBOX, "agents", agentName, "reports");
    if (!existsSync(reportsDir)) { res.writeHead(200, cors); res.end(JSON.stringify([])); return; }
    const files = readdirSync(reportsDir).map(f => ({
      name: f, agent: agentName,
      size: require("fs").statSync(join(reportsDir, f)).size,
      url: `/api/download/${agentName}/${f}`
    }));
    res.writeHead(200, cors);
    res.end(JSON.stringify(files));
    return;
  }

  // Download agent report file
  if (req.method === "GET" && req.url.startsWith("/api/download/")) {
    const parts = req.url.split("/api/download/")[1].split("/");
    const agentName = parts[0];
    const fname = decodeURIComponent(parts.slice(1).join("/"));
    const fpath = join(SANDBOX, "agents", agentName, "reports", fname);
    if (!existsSync(fpath) || fname.includes("..")) { res.writeHead(404, cors); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${fname}"` });
    res.end(readFileSync(fpath));
    return;
  }

  // File upload (multipart — simple boundary parsing)
  if (req.method === "POST" && req.url === "/api/upload") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "no boundary" })); return; }

    const boundary = boundaryMatch[1];
    const parts = body.toString("binary").split("--" + boundary);
    let filename = "upload";
    let fileData = null;

    for (const part of parts) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const headers = part.substring(0, headerEnd);
      const fnMatch = headers.match(/filename="([^"]+)"/);
      if (fnMatch) {
        filename = fnMatch[1];
        const dataStart = headerEnd + 4;
        const dataEnd = part.lastIndexOf("\r\n");
        fileData = Buffer.from(part.substring(dataStart, dataEnd), "binary");
      }
    }

    if (fileData) {
      const dest = join(SANDBOX, "shared", filename);
      writeFileSync(dest, fileData);
      logSandbox(`File uploaded: ${filename} (${fileData.length} bytes)`);
      res.writeHead(200, cors);
      res.end(JSON.stringify({ status: "uploaded", filename, size: fileData.length, path: dest }));
    } else {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ error: "no file data" }));
    }
    return;
  }

  // List shared files
  if (req.method === "GET" && req.url === "/api/files") {
    const shared = join(SANDBOX, "shared");
    const files = existsSync(shared) ? readdirSync(shared).filter(f => !f.startsWith(".") && f !== "TASKS.json")
      .map(f => ({ name: f, size: require("fs").statSync(join(shared, f)).size })) : [];
    res.writeHead(200, cors);
    res.end(JSON.stringify(files));
    return;
  }

  // Download shared file
  if (req.method === "GET" && req.url.startsWith("/api/files/")) {
    const fname = decodeURIComponent(req.url.split("/api/files/")[1]);
    const fpath = join(SANDBOX, "shared", fname);
    if (!existsSync(fpath) || fname.includes("..")) { res.writeHead(404, cors); res.end(JSON.stringify({ error: "not found" })); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${fname}"` });
    res.end(readFileSync(fpath));
    return;
  }

  // Serve dashboard
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    const htmlPath = join(SANDBOX, "ui", "index.html");
    if (existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(htmlPath));
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Sandbox — No UI found</h1>");
    }
    return;
  }

  // Metrics — sandbox_vm + gpu_server
  if (req.method === "GET" && req.url === "/api/metrics") {
    const metrics = { sandbox_vm: {}, gpu_server: {} };
    try {
      // Greenbow CPU/RAM from node_exporter
      const gRes = await fetch("http://localhost:9100/metrics", { signal: AbortSignal.timeout(3000) });
      const gText = await gRes.text();
      const memTotal = gText.match(/^node_memory_MemTotal_bytes\s+([\d.e+]+)/m);
      const memAvail = gText.match(/^node_memory_MemAvailable_bytes\s+([\d.e+]+)/m);
      if (memTotal && memAvail) {
        metrics.sandbox_vm.ramTotalGB = (parseFloat(memTotal[1]) / 1073741824).toFixed(1);
        metrics.sandbox_vm.ramUsedGB = ((parseFloat(memTotal[1]) - parseFloat(memAvail[1])) / 1073741824).toFixed(1);
      }
    } catch {}
    try {
      // Barracuda from node_exporter
      const bRes = await fetch("http://GPU_HOST:9100/metrics", { signal: AbortSignal.timeout(3000) });
      const bText = await bRes.text();
      const memTotal = bText.match(/^node_memory_MemTotal_bytes\s+([\d.e+]+)/m);
      const memAvail = bText.match(/^node_memory_MemAvailable_bytes\s+([\d.e+]+)/m);
      if (memTotal && memAvail) {
        metrics.gpu_server.ramTotalGB = (parseFloat(memTotal[1]) / 1073741824).toFixed(1);
        metrics.gpu_server.ramUsedGB = ((parseFloat(memTotal[1]) - parseFloat(memAvail[1])) / 1073741824).toFixed(1);
      }
    } catch {}
    try {
      // Barracuda GPU via HTTP metrics API
      const gpuRes = await fetch("http://GPU_HOST:9105/", { signal: AbortSignal.timeout(3000) });
      const gpuData = await gpuRes.json();
      metrics.gpu_server.gpus = gpuData.gpus || [];
    } catch {}
    res.writeHead(200, cors);
    res.end(JSON.stringify(metrics));
    return;
  }

  // All agent reports
  if (req.method === "GET" && req.url === "/api/reports") {
    const reports = {};
    for (const [name, agent] of Object.entries(AGENTS)) {
      const reportsDir = join(agent.workspace, "reports");
      if (existsSync(reportsDir)) {
        reports[name] = readdirSync(reportsDir).filter(f => !f.startsWith(".")).map(f => {
          const fpath = join(reportsDir, f);
          const isText = /\.(md|txt|py|json|csv|html|log)$/i.test(f);
          return {
            name: f, agent: name,
            size: require("fs").statSync(fpath).size,
            content: isText ? readFileSync(fpath, "utf-8").substring(0, 5000) : null,
          };
        });
      }
    }
    res.writeHead(200, cors);
    res.end(JSON.stringify(reports));
    return;
  }

  // Metrics history (persisted)
  if (req.method === "GET" && req.url === "/api/metrics-history") {
    const histFile = join(SANDBOX, "logs", "metrics-history.json");
    if (existsSync(histFile)) {
      res.writeHead(200, cors);
      res.end(readFileSync(histFile));
    } else {
      res.writeHead(200, cors);
      res.end(JSON.stringify({ timestamps: [], sandbox_vm_ram: [], gpu0_vram: [], gpu0_temp: [], gpu1_vram: [] }));
    }
    return;
  }

  // Synapse logs
  if (req.method === "GET" && req.url === "/api/logs") {
    const { date } = localDateTime();
    const logFile = join(SANDBOX, "logs", `sandbox-${date}.log`);
    const content = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    res.writeHead(200, cors);
    res.end(JSON.stringify({ date, content }));
    return;
  }

  res.writeHead(404, cors);
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Auto-drain: process pending tasks when queue is idle ──
setInterval(() => {
  if (activeJobs >= MAX_CONCURRENT) return; // busy
  if (jobQueue.length > 0) return; // queue has items being processed

  const tasks = loadTasks();
  const pending = tasks.filter(t => t.status === "pending").sort((a, b) => (a.created || "").localeCompare(b.created || ""));
  if (!pending.length) return;

  const task = pending[0];
  logSandbox(`[auto-drain] Processing pending task ${task.id} for ${task.agent}`);
  updateTask(task.id, { status: "in_progress" });

  const job = {
    agent: task.agent,
    prompt: task.prompt,
    resolve: (result) => {
      const responseText = result.result || "";
      // Detect files
      const fileRefs = responseText.match(/(?:~\/sandbox|\/home\/sandbox_vm\/sandbox)\/[^\s\n)]+/g) || [];
      const attachedFiles = [];
      for (const ref of fileRefs) {
        const fpath = ref.replace("~/sandbox", join(HOME, "sandbox"));
        if (existsSync(fpath) && require("fs").statSync(fpath).isFile()) {
          if (/\.(md|txt|py|json|csv|html|js|sh|log)$/i.test(fpath)) {
            attachedFiles.push({ name: fpath.split("/").pop(), path: ref, content: readFileSync(fpath, "utf-8").substring(0, 20000) });
          } else {
            attachedFiles.push({ name: fpath.split("/").pop(), path: ref, size: require("fs").statSync(fpath).size });
          }
        }
      }
      const taskData = loadTasks().find(t => t.id === task.id);
      if (taskData) {
        if (!taskData.messages) taskData.messages = [{ role: "user", content: task.prompt, ts: task.created }];
        taskData.messages.push({ role: "agent", agent: task.agent, content: responseText, ts: localDateTime().iso, files: attachedFiles.length ? attachedFiles : undefined });
        updateTask(task.id, { status: "completed", completed: localDateTime().iso, result: responseText.substring(0, 2000), messages: taskData.messages });
      } else {
        updateTask(task.id, { status: "completed", completed: localDateTime().iso, result: responseText.substring(0, 2000) });
      }
      logSandbox(`[auto-drain] Task ${task.id} completed`);
    },
    reject: (err) => {
      updateTask(task.id, { status: "failed", error: err.message?.substring(0, 500) });
      logSandbox(`[auto-drain] Task ${task.id} failed: ${err.message}`);
    }
  };

  processJob(job);
}, 10000); // Check every 10 seconds

// ── Persistent metrics collector ──
const METRICS_HIST_FILE = join(SANDBOX, "logs", "metrics-history.json");
const METRICS_MAX = 720; // 1 hour at 5s intervals
let metricsHist;
try { metricsHist = JSON.parse(readFileSync(METRICS_HIST_FILE, "utf-8")); } catch { metricsHist = { timestamps: [], sandbox_vm_ram: [], gpu0_vram: [], gpu0_temp: [], gpu1_vram: [] }; }

setInterval(async () => {
  try {
    const gRes = await fetch("http://localhost:9100/metrics", { signal: AbortSignal.timeout(3000) });
    const gText = await gRes.text();
    const memTotal = gText.match(/^node_memory_MemTotal_bytes\s+([\d.e+]+)/m);
    const memAvail = gText.match(/^node_memory_MemAvailable_bytes\s+([\d.e+]+)/m);
    const ramUsed = memTotal && memAvail ? (parseFloat(memTotal[1]) - parseFloat(memAvail[1])) / 1073741824 : 0;
    metricsHist.sandbox_vm_ram.push(parseFloat(ramUsed.toFixed(1)));
    metricsHist.timestamps.push(Date.now());
  } catch { metricsHist.sandbox_vm_ram.push(0); metricsHist.timestamps.push(Date.now()); }
  try {
    const gpuRes = await fetch(`http://${process.env.ANTHROPIC_BASE_URL?.match(/\/\/([\d.]+)/)?.[1] || "GPU_HOST"}:9105/`, { signal: AbortSignal.timeout(3000) });
    const gpuData = await gpuRes.json();
    metricsHist.gpu0_vram.push(parseInt(gpuData.gpus?.[0]?.memUsed) || 0);
    metricsHist.gpu0_temp.push(parseInt(gpuData.gpus?.[0]?.temp) || 0);
    metricsHist.gpu1_vram.push(parseInt(gpuData.gpus?.[1]?.memUsed) || 0);
  } catch { metricsHist.gpu0_vram.push(0); metricsHist.gpu0_temp.push(0); metricsHist.gpu1_vram.push(0); }
  // Trim
  while (metricsHist.timestamps.length > METRICS_MAX) {
    metricsHist.timestamps.shift(); metricsHist.sandbox_vm_ram.shift();
    metricsHist.gpu0_vram.shift(); metricsHist.gpu0_temp.shift(); metricsHist.gpu1_vram.shift();
  }
  // Persist
  try { writeFileSync(METRICS_HIST_FILE, JSON.stringify(metricsHist)); } catch {}
}, 5000);

server.listen(PORT, "0.0.0.0", () => {
  logSandbox(`Sandbox Synapse v2 (SDK) listening on :${PORT}`);
  logSandbox(`Model: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL || "not set"}`);
  logSandbox(`Agents: ${Object.keys(AGENTS).join(", ")}`);

  // Recover pending/in_progress tasks from before restart
  const tasks = loadTasks();
  const stuck = tasks.filter(t => t.status === "in_progress");
  const pending = tasks.filter(t => t.status === "pending");
  for (const t of stuck) {
    updateTask(t.id, { status: "failed", error: "Interrupted by restart" });
    logSandbox(`[${t.agent}] Task ${t.id} marked failed (interrupted by restart)`);
  }
  if (pending.length) {
    logSandbox(`Found ${pending.length} pending tasks — re-queuing`);
  }
  // Show pending tasks in dashboard (they stay as "pending" for manual run)
});
