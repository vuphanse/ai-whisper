#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="$REPO_ROOT"
SOURCE="claude"
TARGET="codex"
MESSAGE="tell me a joke"
AMEND_LINE="${AI_WHISPER_MOUNTED_PROBE_AMEND_LINE:-Is this a good joke?}"
WAIT_MONITOR_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_MONITOR_MS:-1500}"
WAIT_MOUNT_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_MOUNT_MS:-6000}"
WAIT_AFTER_HANDOFF_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_AFTER_HANDOFF_MS:-3000}"
WAIT_AFTER_ACCEPT_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_AFTER_ACCEPT_MS:-12000}"
WAIT_BEFORE_HANDBACK_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_BEFORE_HANDBACK_MS:-35000}"
WAIT_AFTER_HANDBACK_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_AFTER_HANDBACK_MS:-3000}"
WAIT_AFTER_SOURCE_AMEND_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_AFTER_SOURCE_AMEND_MS:-2000}"
WAIT_AFTER_SOURCE_RESPONSE_MS="${AI_WHISPER_MOUNTED_PROBE_WAIT_AFTER_SOURCE_RESPONSE_MS:-15000}"
NO_BUILD=0
RESET_RUNTIME=0
KEEP_SESSION=1

usage() {
  cat <<'EOF'
Usage: phase-7e-mounted-turn-handoff-probe.sh [options]

Options:
  --workspace <path>              Workspace root (default: repo root)
  --source <codex|claude>         Sender/initiator provider (default: claude)
  --target <codex|claude>         Receiver/owner provider (default: codex)
  --message <text>                Handoff message payload
  --amend-line <text>             Extra line appended when the returned handoff is amended
  --wait-monitor-ms <ms>          Wait after relay-monitor starts
  --wait-mount-ms <ms>            Wait after provider mounts
  --wait-after-handoff-ms <ms>    Wait after sending @@handoff
  --wait-after-accept-ms <ms>     Wait after pressing accept
  --wait-before-handback-ms <ms>  Wait before pressing handback
  --wait-after-handback-ms <ms>   Wait after pressing handback
  --wait-after-source-amend-ms <ms>     Wait after source-side amend composer submits
  --wait-after-source-response-ms <ms>  Wait after source submits the amended prompt
  --reset-runtime                 Remove current-collab.json and broker.sqlite before start
  --no-build                      Skip pnpm build
  --no-keep-session               Kill the tmux session on exit
  --help                          Show this message
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
    --amend-line)
      AMEND_LINE="${2:-}"
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
    --wait-after-handoff-ms)
      WAIT_AFTER_HANDOFF_MS="${2:-}"
      shift 2
      ;;
    --wait-after-accept-ms)
      WAIT_AFTER_ACCEPT_MS="${2:-}"
      shift 2
      ;;
    --wait-before-handback-ms)
      WAIT_BEFORE_HANDBACK_MS="${2:-}"
      shift 2
      ;;
    --wait-after-handback-ms)
      WAIT_AFTER_HANDBACK_MS="${2:-}"
      shift 2
      ;;
    --wait-after-source-amend-ms)
      WAIT_AFTER_SOURCE_AMEND_MS="${2:-}"
      shift 2
      ;;
    --wait-after-source-response-ms)
      WAIT_AFTER_SOURCE_RESPONSE_MS="${2:-}"
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
LOG_DIR="$WORKSPACE/.ai-whisper/manual/phase-7e-mounted-turn-handoff-probe/$TIMESTAMP"
SESSION_NAME="mounted-turn-probe-$TIMESTAMP"

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

if command -v lsof >/dev/null 2>&1; then
  if lsof -n -P -iTCP:4311 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 4311 is still in use after collab cleanup. Kill the leftover broker first." >&2
    lsof -n -P -iTCP:4311 -sTCP:LISTEN >&2 || true
    exit 1
  fi
fi

echo "+ node packages/cli/dist/bin/whisper.js collab start --no-launch"
node packages/cli/dist/bin/whisper.js collab start --no-launch | tee "$LOG_DIR/start.log"

MONITOR_CMD="cd '$WORKSPACE' && node packages/cli/dist/bin/whisper.js collab relay-monitor"
SOURCE_CMD="cd '$WORKSPACE' && AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$SOURCE-input.log' node packages/cli/dist/bin/whisper.js collab mount $SOURCE"
TARGET_CMD="cd '$WORKSPACE' && AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$TARGET-input.log' node packages/cli/dist/bin/whisper.js collab mount $TARGET"

echo "+ tmux new-session -d -s $SESSION_NAME"
tmux new-session -d -s "$SESSION_NAME" -n monitor "$MONITOR_CMD"
tmux new-window -t "$SESSION_NAME" -n "$SOURCE" "$SOURCE_CMD"
tmux new-window -t "$SESSION_NAME" -n "$TARGET" "$TARGET_CMD"
tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null

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

echo "+ wait for provider mounts"
sleep_ms "$WAIT_MOUNT_MS"
capture_window "$SOURCE" "$SOURCE.after-mount"
capture_window "$TARGET" "$TARGET.after-mount"

echo "+ send handoff from $SOURCE to $TARGET"
tmux send-keys -t "$SESSION_NAME:$SOURCE" "@@$TARGET $MESSAGE" Enter
sleep_ms "$WAIT_AFTER_HANDOFF_MS"
capture_window "$SOURCE" "$SOURCE.after-handoff"
capture_window "$TARGET" "$TARGET.after-handoff"
capture_window "monitor" "monitor.after-handoff"

echo "+ accept handoff in $TARGET"
tmux send-keys -t "$SESSION_NAME:$TARGET" "a"
sleep_ms "$WAIT_AFTER_ACCEPT_MS"
capture_window "$TARGET" "$TARGET.after-accept"
capture_window "monitor" "monitor.after-accept"

echo "+ wait before handback readiness"
sleep_ms "$WAIT_BEFORE_HANDBACK_MS"
capture_window "$TARGET" "$TARGET.before-handback"

echo "+ attempt handback in $TARGET"
tmux send-keys -t "$SESSION_NAME:$TARGET" "h"
sleep_ms "$WAIT_AFTER_HANDBACK_MS"
capture_window "$TARGET" "$TARGET.after-handback"
capture_window "monitor" "monitor.after-handback"

if grep -q "Response copied, Enter to hand back or Esc to cancel" "$LOG_DIR/$TARGET.after-handback.txt"; then
  echo "+ confirm copied-response handback"
  tmux send-keys -t "$SESSION_NAME:$TARGET" Enter
  sleep_ms 2000
  capture_window "$SOURCE" "$SOURCE.after-handback-confirm"
  capture_window "$TARGET" "$TARGET.after-handback-confirm"
  capture_window "monitor" "monitor.after-handback-confirm"
fi

if [[ -f "$LOG_DIR/$SOURCE.after-handback-confirm.txt" ]]; then
  echo "+ amend returned handoff in $SOURCE"
  tmux send-keys -t "$SESSION_NAME:$SOURCE" "e"
  sleep_ms 1000
  tmux send-keys -t "$SESSION_NAME:$SOURCE" -l "$AMEND_LINE"
  tmux send-keys -t "$SESSION_NAME:$SOURCE" Enter
  tmux send-keys -t "$SESSION_NAME:$SOURCE" -l "/submit"
  tmux send-keys -t "$SESSION_NAME:$SOURCE" Enter
  sleep_ms "$WAIT_AFTER_SOURCE_AMEND_MS"
  capture_window "$SOURCE" "$SOURCE.after-amend-submit"
  capture_window "monitor" "monitor.after-source-amend"

  echo "+ submit amended prompt in $SOURCE"
  tmux send-keys -t "$SESSION_NAME:$SOURCE" Enter
  sleep_ms "$WAIT_AFTER_SOURCE_RESPONSE_MS"
  capture_window "$SOURCE" "$SOURCE.after-amend-response"
fi

if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$LOG_DIR/current-collab.json"
fi

: >"$SUMMARY_FILE"
echo "Mounted turn handoff probe summary" | tee -a "$SUMMARY_FILE"
echo "source=$SOURCE target=$TARGET message=$MESSAGE" | tee -a "$SUMMARY_FILE"
echo "amend_line=$AMEND_LINE" | tee -a "$SUMMARY_FILE"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Turn owner: $TARGET" "turn owner flips to target after handoff"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Waiting: $SOURCE" "sender waits after handoff"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Handoff: pending" "monitor shows pending handoff"
check_contains "$LOG_DIR/monitor.after-accept.txt" "Handoff: accepted" "monitor shows accepted handoff"
check_contains "$LOG_DIR/$TARGET-input.log" "\"type\":\"programmatic-submit\"" "target log records programmatic submit intent"
check_contains "$LOG_DIR/$TARGET-input.log" "$MESSAGE" "target log records injected handoff text"
check_contains "$LOG_DIR/$TARGET.before-handback.txt" "Ready to hand back to $SOURCE" "owner becomes ready to hand back"
check_contains "$LOG_DIR/$TARGET.after-handback.txt" "Response copied, Enter to hand back or Esc to cancel" "handback copy confirmation appears"
if [[ -f "$LOG_DIR/monitor.after-handback-confirm.txt" ]]; then
  check_contains "$LOG_DIR/monitor.after-handback-confirm.txt" "Turn owner: $SOURCE" "handback flips turn to source"
  check_contains "$LOG_DIR/monitor.after-handback-confirm.txt" "Waiting: $TARGET" "former owner waits after handback"
  if [[ -f "$LOG_DIR/$SOURCE.after-handback-confirm.txt" ]]; then
    check_contains "$LOG_DIR/$SOURCE.after-handback-confirm.txt" "Pending handoff from $TARGET" "source receives returned handoff card"
    if [[ -f "$LOG_DIR/$SOURCE.after-amend-submit.txt" ]]; then
      check_contains "$LOG_DIR/$SOURCE-input.log" "$AMEND_LINE" "source log records amended handoff text"
      check_contains "$LOG_DIR/$SOURCE.after-amend-submit.txt" "$AMEND_LINE" "source pane shows amended handoff text"
      check_contains "$LOG_DIR/monitor.after-source-amend.txt" "Handoff: accepted" "monitor shows accepted handoff after source amend"
      if [[ -f "$LOG_DIR/$SOURCE.after-amend-response.txt" ]]; then
        check_contains "$LOG_DIR/$SOURCE.after-amend-response.txt" "$AMEND_LINE" "source pane retains amended prompt during response wait"
      else
        echo "FAIL  source amended response capture exists" | tee -a "$SUMMARY_FILE"
        PROBE_OK=0
      fi
    else
      echo "FAIL  source amend capture exists" | tee -a "$SUMMARY_FILE"
      PROBE_OK=0
    fi
  else
    echo "FAIL  source handback capture exists" | tee -a "$SUMMARY_FILE"
    PROBE_OK=0
  fi
else
  echo "FAIL  handback confirmation capture exists" | tee -a "$SUMMARY_FILE"
  PROBE_OK=0
fi

if [[ "$PROBE_OK" -eq 1 ]]; then
  echo "Probe verdict: PASS" | tee -a "$SUMMARY_FILE"
else
  echo "Probe verdict: FAIL" | tee -a "$SUMMARY_FILE"
fi

cat <<EOF

Mounted turn handoff probe complete.

tmux session:
  tmux attach -t $SESSION_NAME

logs:
  $LOG_DIR/start.log
  $LOG_DIR/monitor.after-start.txt
  $LOG_DIR/monitor.after-handoff.txt
  $LOG_DIR/monitor.after-accept.txt
  $LOG_DIR/monitor.after-handback.txt
  $LOG_DIR/monitor.after-source-amend.txt
  $LOG_DIR/$SOURCE.after-mount.txt
  $LOG_DIR/$SOURCE.after-handoff.txt
  $LOG_DIR/$SOURCE.after-handback-confirm.txt
  $LOG_DIR/$SOURCE.after-amend-submit.txt
  $LOG_DIR/$SOURCE.after-amend-response.txt
  $LOG_DIR/$TARGET.after-mount.txt
  $LOG_DIR/$TARGET.after-handoff.txt
  $LOG_DIR/$TARGET.after-accept.txt
  $LOG_DIR/$TARGET.before-handback.txt
  $LOG_DIR/$TARGET.after-handback.txt
  $LOG_DIR/$SOURCE-input.log
  $LOG_DIR/$TARGET-input.log
  $SUMMARY_FILE

Notes:
  - This harness drives the real mounted flow with relay-monitor and both providers.
  - It records what the providers actually did, then writes a PASS/FAIL summary from the captured artifacts.
  - Use the captured pane logs plus *-input.log files to compare human input, programmatic-write, and programmatic-submit events against visible TUI behavior.
EOF

if [[ "$PROBE_OK" -ne 1 ]]; then
  exit 1
fi
