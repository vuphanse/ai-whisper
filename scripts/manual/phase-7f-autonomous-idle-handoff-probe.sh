#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="$REPO_ROOT"
SOURCE="claude"
TARGET="codex"
MESSAGE="reply with exactly the word: done"
IDLE_THRESHOLD_MS="${AI_WHISPER_IDLE_THRESHOLD_MS:-10000}"
WAIT_MONITOR_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_MONITOR_MS:-1500}"
WAIT_MOUNT_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_MOUNT_MS:-8000}"
WAIT_AFTER_INTERRUPT_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_AFTER_INTERRUPT_MS:-3000}"
WAIT_AFTER_HANDOFF_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_AFTER_HANDOFF_MS:-15000}"
WAIT_FOR_PROVIDER_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_FOR_PROVIDER_MS:-60000}"
WAIT_AFTER_AUTO_HANDBACK_MS="${AI_WHISPER_AUTONOMOUS_PROBE_WAIT_AFTER_AUTO_HANDBACK_MS:-3000}"
NO_BUILD=0
RESET_RUNTIME=0
KEEP_SESSION=1

usage() {
  cat <<'EOF'
Usage: phase-7f-autonomous-idle-handoff-probe.sh [options]

Proves the autonomous idle auto-accept and auto-handback flow end-to-end.
No 'a' or 'h' keypresses are sent to the target window. The target session
autonomously accepts the pending handoff once it has been idle for
IDLE_THRESHOLD_MS, processes the task, and autonomously handbacks once the
provider goes quiet for another IDLE_THRESHOLD_MS period.

Options:
  --workspace <path>              Workspace root (default: repo root)
  --source <codex|claude>         Sender/initiator provider (default: claude)
  --target <codex|claude>         Receiver/autonomous provider (default: codex)
  --message <text>                Handoff message payload sent from source to target
  --idle-threshold-ms <ms>        Idle threshold for the target session (default: 10000)
                                  Sets AI_WHISPER_IDLE_THRESHOLD_MS on the target mount.
                                  Minimum: 5000 (spec-enforced clamp).
  --wait-monitor-ms <ms>          Wait after relay-monitor starts (default: 1500)
  --wait-mount-ms <ms>            Wait after providers mount and settle (default: 8000)
  --wait-after-interrupt-ms <ms>  Wait after Ctrl-C is sent to target to settle at prompt (default: 3000)
  --wait-after-handoff-ms <ms>    Wait after @@handoff is sent; must exceed --idle-threshold-ms
                                  so auto-accept has time to fire (default: 15000)
  --wait-for-provider-ms <ms>     Wait for the target provider to process the task and for
                                  auto-handback to fire; should cover provider response time
                                  plus another idle threshold period (default: 60000)
  --wait-after-auto-handback-ms <ms>  Brief wait after auto-handback capture for inspect to
                                      settle (default: 3000)
  --reset-runtime                 Remove current-collab.json and broker.sqlite before start
  --no-build                      Skip pnpm build
  --no-keep-session               Kill the tmux session on exit
  --help                          Show this message

Recommended setup for best results:
  Mount target provider with auto-allow-permissions enabled to prevent permission
  prompts from resetting the idle clock prematurely:
    claude: --dangerously-skip-permissions
    codex:  auto-approve mode (set in provider config)

  Use --message with a short, unambiguous task so the provider responds quickly
  and the idle clock fires after a brief quiet period.

Example:
  ./scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh \
    --source claude --target codex \
    --idle-threshold-ms 10000 \
    --wait-for-provider-ms 45000
EOF
}

sleep_ms() {
  local ms="$1"
  sleep "$(awk "BEGIN { printf \"%.3f\", ${ms} / 1000 }")"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --source)
      SOURCE="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --idle-threshold-ms)
      IDLE_THRESHOLD_MS="${2:-}"
      shift 2
      ;;
    --wait-monitor-ms)
      WAIT_MONITOR_MS="${2:-}"
      shift 2
      ;;
    --wait-mount-ms)
      WAIT_MOUNT_MS="${2:-}"
      shift 2
      ;;
    --wait-after-interrupt-ms)
      WAIT_AFTER_INTERRUPT_MS="${2:-}"
      shift 2
      ;;
    --wait-after-handoff-ms)
      WAIT_AFTER_HANDOFF_MS="${2:-}"
      shift 2
      ;;
    --wait-for-provider-ms)
      WAIT_FOR_PROVIDER_MS="${2:-}"
      shift 2
      ;;
    --wait-after-auto-handback-ms)
      WAIT_AFTER_AUTO_HANDBACK_MS="${2:-}"
      shift 2
      ;;
    --reset-runtime)
      RESET_RUNTIME=1
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --no-keep-session)
      KEEP_SESSION=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$SOURCE" != "codex" && "$SOURCE" != "claude" ]]; then
  echo "--source must be codex or claude" >&2
  exit 1
fi

if [[ "$TARGET" != "codex" && "$TARGET" != "claude" ]]; then
  echo "--target must be codex or claude" >&2
  exit 1
fi

if [[ "$SOURCE" == "$TARGET" ]]; then
  echo "--source and --target must differ" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for this probe harness" >&2
  exit 1
fi

cd "$WORKSPACE"

RUNTIME_DIR="$WORKSPACE/.ai-whisper/runtime"
STATE_FILE="$RUNTIME_DIR/current-collab.json"
SQLITE_FILE="$RUNTIME_DIR/broker.sqlite"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$WORKSPACE/.ai-whisper/manual/phase-7f-autonomous-idle-handoff-probe/$TIMESTAMP"
SESSION_NAME="autonomous-idle-probe-$TIMESTAMP"

mkdir -p "$LOG_DIR"

cleanup() {
  if [[ "$KEEP_SESSION" -eq 0 ]]; then
    tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$NO_BUILD" -ne 1 ]]; then
  echo "+ pnpm build"
  pnpm build
fi

if [[ -f "$STATE_FILE" ]]; then
  echo "+ node packages/cli/dist/bin/whisper.js collab stop"
  node packages/cli/dist/bin/whisper.js collab stop || true
fi

if [[ "$RESET_RUNTIME" -eq 1 ]]; then
  echo "+ rm -f $STATE_FILE $SQLITE_FILE"
  rm -f "$STATE_FILE" "$SQLITE_FILE"
fi

# Kill leftover probe sessions from previous runs so dead panes don't interfere
for old_session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^autonomous-idle-probe-'); do
  echo "+ killing leftover tmux session: $old_session"
  tmux kill-session -t "$old_session" 2>/dev/null || true
done

if command -v lsof >/dev/null 2>&1; then
  if lsof -n -P -iTCP:4311 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 4311 is still in use after collab cleanup. Kill the leftover broker first." >&2
    lsof -n -P -iTCP:4311 -sTCP:LISTEN >&2 || true
    exit 1
  fi
fi

echo "+ node packages/cli/dist/bin/whisper.js collab start --no-launch"
node packages/cli/dist/bin/whisper.js collab start --no-launch | tee "$LOG_DIR/start.log"

# Let the broker daemon finish initialization writes before mount commands
# issue attach claims — avoids SQLITE_BUSY on fresh databases.
echo "+ waiting for broker daemon to settle"
sleep 2

# Each command ends with "; exec sleep 86400" so the tmux pane stays alive
# after the mount exits — makes the error visible in captured pane output
# regardless of whether remain-on-exit propagated correctly.
MONITOR_CMD="cd '$WORKSPACE' && node packages/cli/dist/bin/whisper.js collab relay-monitor; exec sleep 86400"
SOURCE_CMD="cd '$WORKSPACE' && AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$SOURCE-input.log' node packages/cli/dist/bin/whisper.js collab mount $SOURCE; exec sleep 86400"
# Target receives AI_WHISPER_IDLE_THRESHOLD_MS so auto-accept and auto-handback engage.
# Source does NOT receive it — source stays manual so the probe terminates after one round.
TARGET_CMD="cd '$WORKSPACE' && AI_WHISPER_IDLE_THRESHOLD_MS=$IDLE_THRESHOLD_MS AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$TARGET-input.log' node packages/cli/dist/bin/whisper.js collab mount $TARGET; exec sleep 86400"

echo "+ tmux new-session -d -s $SESSION_NAME"
tmux new-session -d -s "$SESSION_NAME" -n monitor "$MONITOR_CMD"
tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null
tmux new-window -t "$SESSION_NAME" -n "$SOURCE" "$SOURCE_CMD"
tmux new-window -t "$SESSION_NAME" -n "$TARGET" "$TARGET_CMD"

capture_window() {
  local window="$1"
  local label="$2"
  tmux capture-pane -t "$SESSION_NAME:$window" -p >"$LOG_DIR/$label.txt"
}

PROBE_OK=1
SUMMARY_FILE="$LOG_DIR/probe-summary.txt"

check_contains() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if grep -Fq "$needle" "$file"; then
    echo "PASS  $label" | tee -a "$SUMMARY_FILE"
  else
    echo "FAIL  $label" | tee -a "$SUMMARY_FILE"
    echo "      missing: $needle" | tee -a "$SUMMARY_FILE"
    PROBE_OK=0
  fi
}

echo "+ wait for relay-monitor"
sleep_ms "$WAIT_MONITOR_MS"
capture_window "monitor" "monitor.after-start"

echo "+ wait for provider mounts to settle"
sleep_ms "$WAIT_MOUNT_MS"
capture_window "$SOURCE" "$SOURCE.after-mount"
capture_window "$TARGET" "$TARGET.after-mount"

echo "+ interrupting any pre-existing task in $TARGET"
tmux send-keys -t "$SESSION_NAME:$TARGET" C-c
sleep_ms "$WAIT_AFTER_INTERRUPT_MS"
capture_window "$TARGET" "$TARGET.after-interrupt"

echo "+ send handoff from $SOURCE to $TARGET"
tmux send-keys -t "$SESSION_NAME:$SOURCE" "@@$TARGET $MESSAGE" Enter
sleep_ms 1000
capture_window "$SOURCE" "$SOURCE.after-handoff"
capture_window "$TARGET" "$TARGET.after-handoff"
capture_window "monitor" "monitor.after-handoff"

# Do NOT send 'a' to $TARGET. Autonomous idle auto-accept fires after IDLE_THRESHOLD_MS.
echo "+ waiting ${WAIT_AFTER_HANDOFF_MS}ms for idle auto-accept to fire (threshold=${IDLE_THRESHOLD_MS}ms)"
sleep_ms "$WAIT_AFTER_HANDOFF_MS"
capture_window "$TARGET" "$TARGET.after-auto-accept"
capture_window "monitor" "monitor.after-auto-accept"

# Do NOT send 'h' to $TARGET. Autonomous idle auto-handback fires after provider goes quiet
# for another IDLE_THRESHOLD_MS period.
echo "+ waiting ${WAIT_FOR_PROVIDER_MS}ms for provider to respond and auto-handback to fire"
sleep_ms "$WAIT_FOR_PROVIDER_MS"
capture_window "$TARGET" "$TARGET.after-auto-handback"
capture_window "monitor" "monitor.after-auto-handback"
capture_window "$SOURCE" "$SOURCE.after-auto-handback"

sleep_ms "$WAIT_AFTER_AUTO_HANDBACK_MS"

echo "+ capturing collab inspect output"
node packages/cli/dist/bin/whisper.js collab inspect >"$LOG_DIR/inspect.after-auto-handback.txt" 2>&1 || true
capture_window "monitor" "monitor.after-inspect"

if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$LOG_DIR/current-collab.json"
fi

: >"$SUMMARY_FILE"
echo "Autonomous idle handoff probe summary" | tee -a "$SUMMARY_FILE"
echo "source=$SOURCE target=$TARGET message=$MESSAGE" | tee -a "$SUMMARY_FILE"
echo "idle_threshold_ms=$IDLE_THRESHOLD_MS" | tee -a "$SUMMARY_FILE"

check_contains "$LOG_DIR/monitor.after-handoff.txt" "Turn owner: $TARGET" "turn owner flips to target after handoff"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Waiting: $SOURCE" "sender waits after handoff"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Handoff: pending" "monitor shows pending handoff"
check_contains "$LOG_DIR/monitor.after-auto-accept.txt" "Handoff: accepted" "monitor shows accepted handoff (autonomous — no 'a' key sent)"
check_contains "$LOG_DIR/$TARGET-input.log" "\"type\":\"programmatic-submit\"" "target log records autonomous programmatic submit"
check_contains "$LOG_DIR/$TARGET-input.log" "$MESSAGE" "target log records injected handoff text"
check_contains "$LOG_DIR/monitor.after-auto-handback.txt" "Turn owner: $SOURCE" "auto-handback flips turn back to source (autonomous — no 'h' key sent)"
check_contains "$LOG_DIR/monitor.after-auto-handback.txt" "Waiting: $TARGET" "former target waits after auto-handback"
check_contains "$LOG_DIR/inspect.after-auto-handback.txt" "Last capture:" "inspect reports captureStatus from autonomous handback"
check_contains "$LOG_DIR/$SOURCE.after-auto-handback.txt" "Pending handoff from $TARGET" "source receives returned handoff card"

if [[ "$PROBE_OK" -eq 1 ]]; then
  echo "Probe verdict: PASS" | tee -a "$SUMMARY_FILE"
else
  echo "Probe verdict: FAIL" | tee -a "$SUMMARY_FILE"
fi

cat <<EOF

Autonomous idle handoff probe complete.

What this probe demonstrated (when PASS):
  - Target accepted the handoff without any 'a' keypress after ${IDLE_THRESHOLD_MS}ms of idle
  - Target handed back the result without any 'h' keypress after provider went quiet
  - captureStatus was recorded and surfaced in collab inspect

tmux session:
  tmux attach -t $SESSION_NAME

logs:
  $LOG_DIR/start.log
  $LOG_DIR/monitor.after-start.txt
  $LOG_DIR/monitor.after-handoff.txt
  $LOG_DIR/monitor.after-auto-accept.txt
  $LOG_DIR/monitor.after-auto-handback.txt
  $LOG_DIR/monitor.after-inspect.txt
  $LOG_DIR/$SOURCE.after-mount.txt
  $LOG_DIR/$SOURCE.after-handoff.txt
  $LOG_DIR/$SOURCE.after-auto-handback.txt
  $LOG_DIR/$TARGET.after-mount.txt
  $LOG_DIR/$TARGET.after-interrupt.txt
  $LOG_DIR/$TARGET.after-handoff.txt
  $LOG_DIR/$TARGET.after-auto-accept.txt
  $LOG_DIR/$TARGET.after-auto-handback.txt
  $LOG_DIR/inspect.after-auto-handback.txt
  $LOG_DIR/$SOURCE-input.log
  $LOG_DIR/$TARGET-input.log
  $SUMMARY_FILE

Notes:
  - AI_WHISPER_IDLE_THRESHOLD_MS=${IDLE_THRESHOLD_MS} was set on the target mount only.
    Source stays manual so the probe terminates after one autonomous round-trip.
  - For best results mount target provider with auto-allow-permissions so permission
    prompts do not reset the idle clock: --dangerously-skip-permissions (claude) or
    auto-approve mode (codex).
  - If the provider takes longer than --wait-for-provider-ms to respond, increase that
    value. The auto-handback fires ${IDLE_THRESHOLD_MS}ms after provider output stops.
EOF

if [[ "$PROBE_OK" -ne 1 ]]; then
  exit 1
fi
