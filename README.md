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
│  llama.cpp with Nemotron-Cascade-2 (24GB GGUF)   │
│  RTX 3090 (24GB) + RTX 3080 (10GB)              │
│  Native Anthropic Messages API at /v1/messages   │
└──────────────────────────────────────────────────┘
```

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
- **Heartbeat** — every 15 min, rotating: coordinator (fleet review), medic (health check), stress tester (chaos test)

## Quick Start

### 1. Model Server

```bash
# On your GPU machine — download and serve
wget 'https://huggingface.co/bartowski/nvidia_Nemotron-Cascade-2-30B-A3B-GGUF/resolve/main/nvidia_Nemotron-Cascade-2-30B-A3B-Q4_K_M.gguf' -O nemotron.gguf

# Dual GPU, 64K context, Anthropic API native
llama-server --model nemotron.gguf --host 0.0.0.0 --port 8080 \
  --n-gpu-layers 99 --ctx-size 65536 --parallel 1 \
  --split-mode layer --tensor-split 24,10
```

### 2. Sandbox VM

```bash
git clone https://github.com/justfeltlikerunning/claude-hive-local.git
cd claude-hive-local
npm install

# Set environment
export ANTHROPIC_BASE_URL=http://YOUR_GPU_HOST:8080
export ANTHROPIC_API_KEY=dummy
node synapse.js
```

### 3. Open Dashboard

`http://YOUR_SANDBOX_HOST:3000`

## Network Security

The sandbox VM should be locked down:
```bash
# Only allow: model server, DNS, dashboard access
ufw default deny outgoing
ufw default deny incoming
ufw allow from YOUR_LAN_CIDR to any port 22    # SSH
ufw allow from YOUR_LAN_CIDR to any port 3000  # Dashboard
ufw allow out to GPU_HOST port 8080 proto tcp    # Model server
ufw allow out 53                                  # DNS
```

## Related

- [claude-hive](https://github.com/justfeltlikerunning/claude-hive) — Production multi-agent system with Claude API
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-agent-sdk) — Anthropic's SDK for building agents

## License

MIT
