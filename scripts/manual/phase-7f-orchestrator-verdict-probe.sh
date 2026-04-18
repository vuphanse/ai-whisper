#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="$REPO_ROOT"
SOURCE="codex"
TARGET="claude"
MESSAGE=""
IDLE_THRESHOLD_MS="${AI_WHISPER_IDLE_THRESHOLD_MS:-10000}"
WAIT_MONITOR_MS="${AI_WHISPER_ORCHESTRATOR_PROBE_WAIT_MONITOR_MS:-1500}"
WAIT_MOUNT_MS="${AI_WHISPER_ORCHESTRATOR_PROBE_WAIT_MOUNT_MS:-8000}"
WAIT_AFTER_HANDOFF_MS="${AI_WHISPER_ORCHESTRATOR_PROBE_WAIT_AFTER_HANDOFF_MS:-15000}"
WAIT_FOR_PROVIDER_MS="${AI_WHISPER_ORCHESTRATOR_PROBE_WAIT_FOR_PROVIDER_MS:-120000}"
WAIT_FOR_ORCHESTRATOR_MS="${AI_WHISPER_ORCHESTRATOR_PROBE_WAIT_FOR_ORCHESTRATOR_MS:-15000}"
NO_BUILD=0
RESET_RUNTIME=0
KEEP_SESSION=1

usage() {
  cat <<'EOF'
Usage: phase-7f-orchestrator-verdict-probe.sh [options]

Proves the relay orchestrator end-to-end: handback triggers LLM evaluator,
evaluator returns verdict=done, broker marks chain resolved, monitor and
inspect surface the verdict.

Requires AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1 and ANTHROPIC_API_KEY in
.env. The CLI loads .env at startup.

The escalate scenario is not exercised here because it depends on
captureStatus=ok to reach the max-rounds check, and PTY capture confidence
is unreliable when the target provider emits verbose tool-use traces. Escalate
is covered by relay-orchestrator.test.ts unit tests.

Options:
  --workspace <path>              Workspace root (default: repo root)
  --source <codex|claude>         Sender/initiator provider (default: claude)
  --target <codex|claude>         Receiver provider (default: codex)
  --message <text>                Handoff message (default: "reply with exactly the word: done")
  --idle-threshold-ms <ms>        Target idle threshold (default: 10000, min 5000)
  --wait-monitor-ms <ms>          Wait after relay-monitor starts (default: 1500)
  --wait-mount-ms <ms>            Wait after providers mount (default: 8000)
  --wait-after-handoff-ms <ms>    Wait after @@handoff; must exceed idle threshold
                                  so auto-accept fires (default: 15000)
  --wait-for-provider-ms <ms>     Wait for provider to respond and auto-handback
                                  to fire (default: 120000)
  --wait-for-orchestrator-ms <ms> Wait after handback for orchestrator poll +
                                  LLM evaluation to complete (default: 15000)
  --reset-runtime                 Remove current-collab.json and broker.sqlite before start
  --no-build                      Skip pnpm build
  --no-keep-session               Kill the tmux session on exit
  --help                          Show this message

Example:
  ./scripts/manual/phase-7f-orchestrator-verdict-probe.sh
  ./scripts/manual/phase-7f-orchestrator-verdict-probe.sh --reset-runtime
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
    --wait-after-handoff-ms)
      WAIT_AFTER_HANDOFF_MS="${2:-}"
      shift 2
      ;;
    --wait-for-provider-ms)
      WAIT_FOR_PROVIDER_MS="${2:-}"
      shift 2
      ;;
    --wait-for-orchestrator-ms)
      WAIT_FOR_ORCHESTRATOR_MS="${2:-}"
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

if [[ -z "$MESSAGE" ]]; then
  MESSAGE="Summarize the purpose of ai-whisper in 2-3 sentences based on README.md."
fi

cd "$WORKSPACE"

RUNTIME_DIR="$WORKSPACE/.ai-whisper/runtime"
STATE_FILE="$RUNTIME_DIR/current-collab.json"
SQLITE_FILE="$RUNTIME_DIR/broker.sqlite"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$WORKSPACE/.ai-whisper/manual/phase-7f-orchestrator-verdict-probe/$TIMESTAMP"
SESSION_NAME="orchestrator-verdict-probe-$TIMESTAMP"

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

for old_session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^orchestrator-verdict-probe-'); do
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

export AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1
echo "+ orchestrator enabled; expecting LLM verdict=done from Anthropic evaluator"

echo "+ node packages/cli/dist/bin/whisper.js collab start --no-launch"
node packages/cli/dist/bin/whisper.js collab start --no-launch | tee "$LOG_DIR/start.log"

echo "+ waiting for broker daemon to settle"
sleep 2

MONITOR_CMD="cd '$WORKSPACE' && node packages/cli/dist/bin/whisper.js collab relay-monitor; exec sleep 86400"
SOURCE_CMD="cd '$WORKSPACE' && AI_WHISPER_IDLE_THRESHOLD_MS=999999 AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$SOURCE-input.log' node packages/cli/dist/bin/whisper.js collab mount $SOURCE; exec sleep 86400"
TARGET_CMD="cd '$WORKSPACE' && AI_WHISPER_IDLE_THRESHOLD_MS=$IDLE_THRESHOLD_MS AI_WHISPER_DEBUG_INPUT_LOG='$LOG_DIR/$TARGET-input.log' AI_WHISPER_DEBUG_CAPTURE='$LOG_DIR/capture-debug.json' node packages/cli/dist/bin/whisper.js collab mount $TARGET; exec sleep 86400"

echo "+ tmux new-session -d -s $SESSION_NAME"
tmux new-session -d -s "$SESSION_NAME" -n monitor "$MONITOR_CMD"
tmux set-option -t "$SESSION_NAME" remain-on-exit on >/dev/null
tmux new-window -t "$SESSION_NAME" -n "$SOURCE" "$SOURCE_CMD"
sleep 3
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
  # Strip newlines first so terminal column wrap (typically 80 chars) does not
  # break literal substring matches against rendered panel output.
  if tr -d '\n' <"$file" | grep -Fq "$needle"; then
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

capture_window "$TARGET" "$TARGET.before-handoff"

echo "+ send handoff from $SOURCE to $TARGET"
tmux send-keys -t "$SESSION_NAME:$SOURCE" "@@$TARGET $MESSAGE" Enter
sleep_ms 1000
capture_window "$SOURCE" "$SOURCE.after-handoff"
capture_window "$TARGET" "$TARGET.after-handoff"
capture_window "monitor" "monitor.after-handoff"

echo "+ waiting ${WAIT_AFTER_HANDOFF_MS}ms for idle auto-accept (threshold=${IDLE_THRESHOLD_MS}ms)"
sleep_ms "$WAIT_AFTER_HANDOFF_MS"
capture_window "$TARGET" "$TARGET.after-auto-accept"
capture_window "monitor" "monitor.after-auto-accept"

echo "+ waiting ${WAIT_FOR_PROVIDER_MS}ms for provider to respond and auto-handback to fire"
sleep_ms "$WAIT_FOR_PROVIDER_MS"
capture_window "$TARGET" "$TARGET.after-auto-handback"
capture_window "monitor" "monitor.after-auto-handback"
capture_window "$SOURCE" "$SOURCE.after-auto-handback"

echo "+ waiting ${WAIT_FOR_ORCHESTRATOR_MS}ms for orchestrator poll and LLM evaluation"
sleep_ms "$WAIT_FOR_ORCHESTRATOR_MS"
capture_window "monitor" "monitor.after-orchestrator"
capture_window "$SOURCE" "$SOURCE.after-orchestrator"

echo "+ capturing collab inspect output"
node packages/cli/dist/bin/whisper.js collab inspect >"$LOG_DIR/inspect.after-orchestrator.txt" 2>&1 || true

if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$LOG_DIR/current-collab.json"
fi

: >"$SUMMARY_FILE"
echo "Orchestrator verdict probe summary" | tee -a "$SUMMARY_FILE"
echo "source=$SOURCE target=$TARGET message=$MESSAGE" | tee -a "$SUMMARY_FILE"
echo "idle_threshold_ms=$IDLE_THRESHOLD_MS" | tee -a "$SUMMARY_FILE"

check_contains "$LOG_DIR/inspect.after-orchestrator.txt" "Orchestrator: yes" "inspect reports Orchestrator: yes"
check_contains "$LOG_DIR/monitor.after-handoff.txt" "Turn owner: $TARGET" "turn owner flips to target after handoff"
check_contains "$LOG_DIR/inspect.after-orchestrator.txt" "Chain status: done" "inspect reports Chain status: done (LLM verdict)"
# monitor assertion on Chain: done omitted — initial panel state also renders
# "Chain: done (round 0/N)" when chainStatus is null, causing false positives.

if [[ "$PROBE_OK" -eq 1 ]]; then
  echo "Probe verdict: PASS" | tee -a "$SUMMARY_FILE"
else
  echo "Probe verdict: FAIL" | tee -a "$SUMMARY_FILE"
fi

cat <<EOF

Orchestrator verdict probe complete.

What this probe demonstrated (when PASS):
  - Orchestrator is enabled in the active collab (Orchestrator: yes)
  - Handback triggered orchestrator LLM evaluation (Anthropic haiku)
  - LLM returned verdict=done; chain resolved (Chain status: done)

tmux session:
  tmux attach -t $SESSION_NAME

logs:
  $LOG_DIR/start.log
  $LOG_DIR/monitor.after-handoff.txt
  $LOG_DIR/monitor.after-auto-accept.txt
  $LOG_DIR/monitor.after-auto-handback.txt
  $LOG_DIR/monitor.after-orchestrator.txt
  $LOG_DIR/$SOURCE.after-orchestrator.txt
  $LOG_DIR/$TARGET.after-auto-handback.txt
  $LOG_DIR/inspect.after-orchestrator.txt
  $SUMMARY_FILE

Notes:
  - Requires ANTHROPIC_API_KEY in .env. Incurs one haiku API call per round.
  - escalate scenario omitted: relies on captureStatus=ok which is unreliable
    when target provider emits verbose tool-use traces. Covered by unit tests.
  - If provider response exceeds --wait-for-provider-ms, bump that flag.
  - If orchestrator poll + LLM latency exceeds --wait-for-orchestrator-ms,
    bump that flag (default 15s covers haiku eval comfortably).
EOF

if [[ "$PROBE_OK" -ne 1 ]]; then
  exit 1
fi
