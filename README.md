# claude-hive-local

Local agent sandbox — battle-test agent orchestration with zero-cost local LLM inference.

Run multiple agents on a single VM using the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) pointed at a local model server (llama.cpp, vLLM, ollama) via `ANTHROPIC_BASE_URL`. Full tool use (Read, Write, Edit, Bash, Glob, Grep) works through the SDK with local models.

## Why

- **Zero API cost** — local model inference, run as much as you want
- **Real tool use** — agents read/write files, execute code, create outputs
- **Autonomy testing** — heartbeat creates work, agents self-organize
- **Battle-testing** — stress tester finds weaknesses, medic fixes failures
- **Fully sandboxed** — no internet access, only the model server

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Sandbox VM (sandbox-vm)                    :3000  │
│                                                  │
│  Synapse — orchestrator + dashboard              │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐          │
│  │Coordinat│ │ Analyst │ │Researcher│          │
│  │  or     │ │         │ │          │          │
│  ├─────────┤ ├─────────┤ ├──────────┤          │
│  │ Builder │ │ Auditor │ │  Medic   │          │
│  ├─────────┤ ├─────────┤ ├──────────┤          │
│  │ Stress  │ │         │ │          │          │
│  │ Tester  │ │         │ │          │          │
│  └─────────┘ └─────────┘ └──────────┘          │
│       ↕ Claude Agent SDK (ANTHROPIC_BASE_URL)    │
└───────────────────────┬─────────────────────────┘
                        │ HTTP :8080
┌───────────────────────┴─────────────────────────┐
│  GPU Server (gpu-server)                          │
│  llama.cpp with Qwen3-Coder-30B-A3B (18GB GGUF)  │
│  RTX 3090 (24GB) + RTX 3080 (10GB)              │
│  Native Anthropic Messages API at /v1/messages   │
└──────────────────────────────────────────────────┘
```

## Recommended Model

**Qwen3-Coder-30B-A3B-Instruct** (Q4_K_M, ~18GB) — best tool calling reliability of models tested:

| Model | Tool Calling | Notes |
|-------|-------------|-------|
| Nemotron-Cascade-2 30B | Poor | Hallucinated tool results instead of using tools |
| Qwen 3.5 35B-A3B | Moderate | Text-based tool format, inconsistent |
| **Qwen3-Coder 30B-A3B** | **Good** | Reliable structured tool use, code-optimized |

## 7 Agents

| Agent | Role | Tools |
|-------|------|-------|
| **Coordinator** | Routes tasks, monitors fleet, creates autonomous work | Full |
| **Analyst** | Data analysis, pattern detection, statistics | Read, Write, Bash, Glob, Grep |
| **Researcher** | File reading, summarization, cross-referencing | Read, Glob, Grep |
| **Builder** | Code writing, script generation, structured output | Full |
| **Auditor** | Quality review, error catching, validation | Read, Glob, Grep |
| **Stress Tester** | Chaos/QA — probes for weaknesses, documents pinch points | Full |
| **Medic** | Self-healing — monitors health, fixes broken agents/tasks | Full |

## Dashboard

Web UI at `:3000` with tabs:
- **Tasks** — HiveLog-style with conversations, @mention pipeline routing, rounds, file attachments
- **Memory** — live memory for all agents
- **Trace** — every LLM call with full prompt/response
- **Files** — upload/download shared workspace
- **Reports** — agent output files (pinch points, health reports, scripts)
- **Metrics** — VM RAM + GPU VRAM/temp/utilization with live charts
- **Logs** — synapse log viewer

## Key Features

- **@mention routing** — `@analyst find patterns. @auditor review.` = sequential pipeline
- **@all** — mention all agents at once
- **Discussion rounds** (1-5) with consensus detection
- **Per-agent output format** — `@builder [py] write a script`
- **File attachments** — upload files inline in conversations
- **Inline file rendering** — agent-created files show expandable in the thread
- **Smart context management** — older rounds get compressed, recent context kept full
- **Error resilience** — failed agents get skipped, pipeline continues
- **Streaming** — shows thinking/tool use as agents work
- **Auto-drain** — pending tasks auto-process when queue is idle (10s check interval)
- **Task cleanup** — kills stuck tasks (>10min), expires stale pending (>30min)
- **Heartbeat** — every 15 min, rotating: coordinator (fleet review), medic (health check), stress tester (chaos test). Skips if queue busy (>2 pending or anything running)

## Quick Start

### 1. Model Server

```bash
# On your GPU machine — download Qwen3-Coder (recommended for tool calling)
wget 'https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf' -O qwen3-coder.gguf

# CRITICAL flags:
#   --jinja          REQUIRED for tool calling (without it, models hallucinate)
#   --parallel 1     SDK system prompt is ~18K tokens, parallel splits context
#   --cache-type-k/v q8_0  saves ~10% VRAM
#   --cache-reuse 256      speeds up repeat requests (system prompt caching)
llama-server --model qwen3-coder.gguf --host 0.0.0.0 --port 8080 \
  --n-gpu-layers 99 --ctx-size 65536 --parallel 1 \
  --split-mode layer --tensor-split 24,10 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --cache-reuse 256 --jinja
```

### 2. Sandbox VM

```bash
git clone https://github.com/justfeltlikerunning/claude-hive-local.git
cd claude-hive-local
npm install

# Set environment
export ANTHROPIC_BASE_URL=http://YOUR_GPU_HOST:8080
export ANTHROPIC_API_KEY=dummy  # llama.cpp accepts any value
node synapse.js
```

### 3. Open Dashboard

`http://YOUR_SANDBOX_HOST:3000`

### 4. Optional: GPU Metrics

To enable the Metrics tab with live GPU charts, run a simple metrics API on your GPU server:

```python
# gpu-metrics.py — serves nvidia-smi data over HTTP
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess, json

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True
        )
        gpus = []
        for line in result.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpus.append({"index": int(parts[0]), "name": parts[1], "utilization": float(parts[2]),
                             "vram_used": float(parts[3]), "vram_total": float(parts[4]), "temp": float(parts[5])})
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"gpus": gpus}).encode())
    def log_message(self, *a): pass

HTTPServer(("0.0.0.0", 9105), Handler).serve_forever()
```

Run with `python3 gpu-metrics.py &` and synapse will auto-detect it.

## Network Security

The sandbox VM should be locked down:
```bash
# Only allow: model server, DNS, dashboard access
ufw default deny outgoing
ufw default deny incoming
ufw allow from YOUR_LAN_CIDR to any port 22    # SSH
ufw allow from YOUR_LAN_CIDR to any port 3000  # Dashboard
ufw allow out to GPU_HOST port 8080 proto tcp    # Model server
ufw allow out to GPU_HOST port 9105 proto tcp    # GPU metrics (optional)
ufw allow out to GPU_HOST port 9100 proto tcp    # node_exporter (optional)
ufw allow out 53                                  # DNS
```

## Key Lessons

1. **llama.cpp has native Anthropic Messages API** — no proxy needed, SDK works directly via `ANTHROPIC_BASE_URL`
2. **`--jinja` flag is REQUIRED** for tool calling — without it, models output raw text instead of structured tool_use blocks
3. **`--parallel 1`** is important — the SDK system prompt is ~18K tokens, and `--parallel` splits context evenly between slots
4. **`ANTHROPIC_API_KEY`** must be set to any non-empty value (llama.cpp accepts anything)
5. **Model choice matters** — Qwen3-Coder significantly outperforms Nemotron-Cascade and base Qwen 3.5 for tool calling
6. **Cache reuse** (`--cache-reuse 256`) gives major speedups since the SDK reuses the same system prompt across calls (0.98+ similarity)
7. **q8_0 KV cache** saves ~10% VRAM with minimal quality impact

## Related

- [claude-hive](https://github.com/justfeltlikerunning/claude-hive) — Production multi-agent system with Claude API
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) — Anthropic's SDK for building agents

## License

MIT
