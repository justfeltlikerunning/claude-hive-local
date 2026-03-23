#!/bin/bash
set -euo pipefail
SYNAPSE="http://localhost:3000"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)
SANDBOX="$HOME/sandbox"
MINUTE=$(date +%M)

# Check synapse health
STATUS=$(curl -sf -m 5 "$SYNAPSE/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")
if [ "$STATUS" != "ok" ]; then exit 0; fi

# Task stats
TASK_FILE="$SANDBOX/shared/TASKS.json"
COMPLETED=$(python3 -c "import json;t=json.load(open('$TASK_FILE'));print(len([x for x in t if x.get('status')=='completed' and x.get('created','').startswith('$DATE')]))" 2>/dev/null || echo 0)
FAILED=$(python3 -c "import json;t=json.load(open('$TASK_FILE'));print(len([x for x in t if x.get('status')=='failed' and x.get('created','').startswith('$DATE')]))" 2>/dev/null || echo 0)

# Rotate duties each heartbeat:
# :00 and :30 — Coordinator fleet review + autonomous work
# :15 — Medic health check
# :45 — Stress tester run

case "$MINUTE" in
  00|30)
    AGENT="coordinator"
    PROMPT="AUTONOMOUS HEARTBEAT ($DATE $TIME). Fleet: $COMPLETED completed, $FAILED failed today. Read all agent memories. If idle, create work: have analyst find patterns, builder create tools, researcher summarize docs. If failures exist, diagnose and retry. Keep the fleet productive."
    ;;
  15)
    AGENT="medic"
    PROMPT="HEALTH CHECK ($DATE $TIME). Fleet: $COMPLETED completed, $FAILED failed. Check all agent memories for errors or stuck tasks. Check ~/sandbox/shared/TASKS.json for failed tasks. If anything is broken, fix it. Write a health report to your reports/health-$DATE.md"
    ;;
  45)
    AGENT="stresstester"
    PROMPT="STRESS TEST ($DATE $TIME). Run a focused test on the sandbox. Pick ONE from: 1) Test what happens when you spawn an agent with an empty prompt 2) Test what happens with a very long prompt (500+ words) 3) Test spawning multiple agents rapidly 4) Test reading a file that doesnt exist. Document results in reports/pinch-points.md with severity ratings and claude-hive impact analysis."
    ;;
  *)
    # Off-cycle — just log heartbeat OK
    echo "- [$TIME] HEARTBEAT_OK" >> "$SANDBOX/agents/coordinator/memory/$DATE.md"
    exit 0
    ;;
esac

curl -sf -m 300 "$SYNAPSE/spawn/$AGENT" \
  -H "Content-Type: application/json" \
  -d "{\"task\": $(echo "$PROMPT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))')}" \
  > /dev/null 2>&1 || echo "[$TIME] Heartbeat spawn failed"

echo "[$TIME] Heartbeat: $AGENT"
