#!/bin/bash
set -euo pipefail
SYNAPSE="http://localhost:3000"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M:%S)
SANDBOX="/home/sandbox_vm/sandbox"
MINUTE=$(date +%M)

# Check synapse health
STATUS=$(curl -sf -m 5 "$SYNAPSE/health" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")
if [ "$STATUS" != "ok" ]; then exit 0; fi

# Run cleanup first — kill stale tasks
curl -sf -m 10 "$SYNAPSE/api/tasks/cleanup" -X POST > /dev/null 2>&1

# Check queue depth — don't create new work if queue is backed up
STATS=$(curl -sf -m 5 "$SYNAPSE/api/tasks/stats" 2>/dev/null || echo '{}')
PENDING=$(echo "$STATS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('pending',0))" 2>/dev/null || echo 0)
IN_PROGRESS=$(echo "$STATS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('in_progress',0))" 2>/dev/null || echo 0)
COMPLETED=$(echo "$STATS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('completed',0))" 2>/dev/null || echo 0)
FAILED=$(echo "$STATS" | python3 -c "import sys,json;print(json.load(sys.stdin).get('failed',0))" 2>/dev/null || echo 0)

# Skip if queue is backed up (more than 2 pending or anything in progress)
if [ "$PENDING" -gt 2 ] 2>/dev/null || [ "$IN_PROGRESS" -gt 0 ] 2>/dev/null; then
  echo "[$TIME] HEARTBEAT_SKIP — queue busy (pending:$PENDING in_progress:$IN_PROGRESS)"
  echo "- [$TIME] HEARTBEAT_SKIP (queue busy: $PENDING pending, $IN_PROGRESS active)" >> "$SANDBOX/agents/coordinator/memory/$DATE.md"
  exit 0
fi

case "$MINUTE" in
  00|30)
    AGENT="coordinator"
    PROMPT="AUTONOMOUS HEARTBEAT ($DATE $TIME). Fleet: $COMPLETED completed, $FAILED failed today. Read agent memories. If idle, create ONE task. Keep it simple."
    ;;
  15)
    AGENT="medic"
    PROMPT="HEALTH CHECK ($DATE $TIME). Fleet: $COMPLETED completed, $FAILED failed. Check for stuck tasks and errors. Write brief health report to reports/health-$DATE.md"
    ;;
  45)
    AGENT="stresstester"
    PROMPT="STRESS TEST ($DATE $TIME). Run ONE focused test. Document in reports/pinch-points.md with severity and claude-hive impact."
    ;;
  *)
    echo "- [$TIME] HEARTBEAT_OK" >> "$SANDBOX/agents/coordinator/memory/$DATE.md"
    exit 0
    ;;
esac

curl -sf -m 300 "$SYNAPSE/spawn/$AGENT" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"heartbeat\",\"task\": $(echo "$PROMPT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read().strip()))')}" \
  > /dev/null 2>&1 || echo "[$TIME] Heartbeat spawn failed"

echo "[$TIME] Heartbeat: $AGENT"
