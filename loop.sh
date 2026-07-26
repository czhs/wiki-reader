#!/bin/bash
set -u
PROMPT_FILE="PROMPT.md"
PROMISE="<promise>MILESTONE_COMPLETE</promise>"
LOG_DIR="logs/ralph"
LIMIT_SLEEP=1800   # 30 min between retries while usage-limited
ITER_SLEEP=15      # small breather between normal iterations
MAX_TURNS=500      # ceiling, not a target. PROMPT.md tells the model to hand off well before it.
MODEL=claude-opus-5

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <iterations>"
  exit 1
fi
if [ ! -s "$PROMPT_FILE" ]; then
  echo "ERROR: $PROMPT_FILE missing or empty" >&2
  exit 1
fi
mkdir -p "$LOG_DIR" state

# --- toolchain preflight -------------------------------------------------------------------
# `better-sqlite3` is a native module compiled per Node ABI. A Homebrew upgrade of node (or of
# pnpm) silently invalidates it, and the failure surfaces as ~93 failing database tests that
# look exactly like a code regression — the loop would spend iterations "fixing" working code.
# Pin the version in .nvmrc and refuse to start if the toolchain cannot load the binding.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || echo "WARN: nvm could not select the version in .nvmrc" >&2
fi

echo "toolchain: node $(node --version 2>/dev/null) (ABI $(node -e 'process.stdout.write(process.versions.modules)' 2>/dev/null)), pnpm $(pnpm --version 2>/dev/null)"

# Two subtleties, both of which produced a false pass while writing this:
#   - Resolve from packages/database, not the repo root. pnpm's isolated linker means
#     better-sqlite3 is only reachable from the package that declares it.
#   - `require()` alone is not enough. The module loads its JS wrapper fine under a wrong
#     ABI and only throws when a database is actually opened, so open one.
if ! node -e "const D=require('module').createRequire('$PWD/packages/database/package.json')('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1; then
  cat >&2 <<'PREFLIGHT'
ERROR: better-sqlite3 does not load under the active Node version.

This is a toolchain mismatch, NOT a code bug. Do not "fix" the database packages.

  nvm install && nvm use            # honours .nvmrc
  pnpm rebuild better-sqlite3       # or: npx prebuild-install -r node

The Electron ABI build is staged separately under
apps/desktop/resources/native/electron-<version>/ and is unaffected by the Node ABI.
PREFLIGHT
  exit 1
fi

i=0
while [ "$i" -lt "$1" ]; do
  i=$((i+1))
  ts=$(date +%Y%m%d_%H%M%S)
  log="$LOG_DIR/iter_${i}_${ts}.log"
  # One line per turn, without ANSI, so a finished run can be read back for pace and stalls
  # without replaying the whole stream. `ralph_pretty.py` appends to it as turns arrive.
  turns_log="$LOG_DIR/iter_${i}_${ts}.turns.log"
  started_epoch=$(date +%s)
  echo "=== Iteration $i started $(date '+%Y-%m-%d %H:%M:%S') -> $log ==="

  RALPH_ITER="$i" RALPH_MAX_TURNS="$MAX_TURNS" RALPH_TURN_LOG="$turns_log" \
    claude -p "$(cat "$PROMPT_FILE")" --model "$MODEL" --output-format stream-json --verbose --include-partial-messages --max-turns "$MAX_TURNS" --dangerously-skip-permissions 2>&1 | tee "$log" | python3 ralph_pretty.py
  exit_code=${PIPESTATUS[0]}

  elapsed=$(( $(date +%s) - started_epoch ))
  # Turn lines start with an ISO timestamp; the trailing [done] line does not. `grep -c`
  # prints 0 *and* exits 1 when nothing matches, so assign-then-default rather than `|| echo`,
  # which would otherwise emit "0" twice.
  turns_taken=$(grep -c '^[0-9]' "$turns_log" 2>/dev/null) || turns_taken=0
  printf -- "--- end iteration %s at %s (exit %s, %s turns, %dm%02ds) ---\n" \
    "$i" "$(date '+%Y-%m-%d %H:%M:%S')" "$exit_code" "$turns_taken" \
    "$((elapsed / 60))" "$((elapsed % 60))"

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
