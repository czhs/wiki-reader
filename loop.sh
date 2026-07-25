#!/bin/bash
set -u
PROMPT_FILE="PROMPT.md"
PROMISE="<promise>MILESTONE_COMPLETE</promise>"
LOG_DIR="logs/ralph"
LIMIT_SLEEP=1800   # 30 min between retries while usage-limited
ITER_SLEEP=15      # small breather between normal iterations
MAX_TURNS=45       # cap session length: keeps context small and per-turn usage cheap

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi
if [ ! -s "$PROMPT_FILE" ]; then
  echo "ERROR: $PROMPT_FILE missing or empty" >&2
  exit 1
fi
mkdir -p "$LOG_DIR" state

i=0
while [ "$i" -lt "$1" ]; do
  i=$((i+1))
  ts=$(date +%Y%m%d_%H%M%S)
  log="$LOG_DIR/iter_${i}_${ts}.log"
  echo "=== Iteration $i ($ts) -> $log ==="

  claude -p "$(cat "$PROMPT_FILE")" --output-format stream-json --verbose --include-partial-messages --max-turns "$MAX_TURNS" --dangerously-skip-permissions 2>&1 | tee "$log" | python3 ralph_pretty.py
  echo "--- end iteration $i (exit ${PIPESTATUS[0]}) ---"

  # Usage/rate limit: check the structured result event only (free-text grep
  # false-positives because the prompt itself discusses usage limits)
  limited=$(python3 - "$log" << 'PYCHECK'
import json, sys
lim = False
for line in open(sys.argv[1]):
    if '"type":"result"' not in line:
        continue
    try:
        ev = json.loads(line)
    except Exception:
        continue
    if ev.get('api_error_status') == 429:
        lim = True
    elif ev.get('is_error') and 'limit' in str(ev.get('result', '')).lower():
        lim = True
print(1 if lim else 0)
PYCHECK
)
  if [ "${limited:-0}" = "1" ]; then
    echo "Usage limit detected; sleeping ${LIMIT_SLEEP}s before retry..."
    i=$((i-1))
    sleep "$LIMIT_SLEEP"
    continue
  fi

  # Promise emitted: trust but verify via the completion verifier
  if grep -qF "$PROMISE" "$log"; then
    if [ -f scripts/verify_completion.py ] && python3 scripts/verify_completion.py; then
      echo "Completion promise confirmed by verifier after $i iterations."
      exit 0
    else
      echo "WARNING: promise emitted but verifier missing or failing; continuing."
    fi
  fi

  # Wait hint: Claude ended the session because only a long wait remains
  if [ -f state/WAIT_HINT ]; then
    w=$(tr -cd '0-9' < state/WAIT_HINT); rm -f state/WAIT_HINT
    w=${w:-600}
    [ "$w" -gt 3600 ] && w=3600
    [ "$w" -lt 60 ] && w=60
    echo "Wait hint honored: sleeping ${w}s before next session..."
    sleep "$w"
    continue
  fi

  sleep "$ITER_SLEEP"
done
echo "Reached max iterations ($1)"
exit 1
