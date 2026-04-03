#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="${AI_WHISPER_MANUAL_WORKSPACE:-$(mktemp -d /tmp/ai-whisper-real-XXXXXX)}"
RUNTIME_ROOT="$WORKSPACE/.ai-whisper/runtime"
STATE_FILE="$RUNTIME_ROOT/current-collab.json"
BROKER_DB="$RUNTIME_ROOT/broker.sqlite"

step() {
  printf '\n== %s ==\n' "$1"
}

substep() {
  printf '\n-- %s --\n' "$1"
}

run_cmd() {
  printf '+ %s\n' "$*"
  "$@"
}

ensure_clean_workspace() {
  if [[ -f "$STATE_FILE" ]]; then
    substep "Existing collab state detected. Stopping it before starting a new run."
    run_cmd node packages/cli/dist/bin/whisper.js collab stop --workspace "$WORKSPACE" || true
  fi

  if [[ -d "$RUNTIME_ROOT" ]]; then
    substep "Removing stale runtime directory"
    run_cmd rm -rf "$RUNTIME_ROOT"
  fi
}

dump_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    substep "Contents of $path"
    cat "$path"
  else
    substep "Missing file: $path"
  fi
}

dump_runtime_tree() {
  if [[ -d "$RUNTIME_ROOT" ]]; then
    substep "Runtime directory tree"
    find "$RUNTIME_ROOT" -maxdepth 3 -print | sort
  else
    substep "Runtime directory not created yet"
  fi
}

dump_process_state() {
  if [[ -f "$STATE_FILE" ]]; then
    local broker_pid=""
    broker_pid="$(node -e 'const fs=require("fs");const p=process.argv[1];const state=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(state.broker?.pid ?? ""));' "$STATE_FILE" 2>/dev/null || true)"
    if [[ -n "$broker_pid" ]]; then
      substep "Broker PID $broker_pid"
      ps -p "$broker_pid" -o pid=,ppid=,stat=,etime=,command= || true
    fi
  fi

  substep "Relevant ai-whisper processes"
  ps -Ao pid=,ppid=,stat=,etime=,command= | grep -E 'ai-whisper|broker-daemon|companion-agent|codex|claude|tmux' | grep -v grep || true
}

dump_tmux_state() {
  if command -v tmux >/dev/null 2>&1; then
    substep "tmux sessions"
    tmux list-sessions 2>/dev/null || echo "No tmux sessions"
  else
    substep "tmux not installed"
  fi
}

status_cmd() {
  run_cmd node packages/cli/dist/bin/whisper.js collab status --workspace "$WORKSPACE"
}

tell_cmd() {
  run_cmd node packages/cli/dist/bin/whisper.js collab tell "$@"
}

show_debug_snapshot() {
  dump_runtime_tree
  dump_file "$STATE_FILE"
  if [[ -f "$BROKER_DB" ]]; then
    substep "Broker sqlite file"
    ls -lh "$BROKER_DB"
  fi
  dump_process_state
  dump_tmux_state
}

cleanup_notice() {
  printf '\n== Script finished ==\n'
  printf 'Workspace kept at: %s\n' "$WORKSPACE"
}
trap cleanup_notice EXIT

cd "$REPO_ROOT"

step "Environment"
run_cmd pwd
run_cmd node --version
run_cmd pnpm --version
substep "Resolved paths"
printf 'REPO_ROOT=%s\n' "$REPO_ROOT"
printf 'WORKSPACE=%s\n' "$WORKSPACE"
printf 'RUNTIME_ROOT=%s\n' "$RUNTIME_ROOT"
printf 'STATE_FILE=%s\n' "$STATE_FILE"
printf 'BROKER_DB=%s\n' "$BROKER_DB"
substep "Detected executables"
command -v codex || true
command -v claude || true
command -v tmux || true

step "Build"
run_cmd pnpm build

step "Prepare workspace"
ensure_clean_workspace
run_cmd mkdir -p "$WORKSPACE"
cat >"$WORKSPACE/plan.md" <<'EOF'
# Test Plan

1. Confirm ai-whisper can route work to Codex and Claude.
2. Confirm replies are written back through the broker.
3. Confirm the active thread is reused across tell commands.
EOF
substep "Workspace contents"
find "$WORKSPACE" -maxdepth 2 -print | sort
dump_file "$WORKSPACE/plan.md"

step "Start collab"
run_cmd node packages/cli/dist/bin/whisper.js collab start --workspace "$WORKSPACE"
show_debug_snapshot

step "Status after start"
status_cmd
show_debug_snapshot

step "Ask Codex to review the plan"
tell_cmd \
  --workspace "$WORKSPACE" \
  --target codex \
  --action review_plan \
  --artifact "$WORKSPACE/plan.md" \
  "Review this plan and return a concise review."
show_debug_snapshot

step "Status after Codex reply"
status_cmd
show_debug_snapshot

step "Ask Claude to summarize the active thread"
tell_cmd \
  --workspace "$WORKSPACE" \
  --target claude \
  --action answer_question \
  "Summarize the current thread state in one sentence."
show_debug_snapshot

step "Final status"
status_cmd
show_debug_snapshot

step "Stop collab"
run_cmd node packages/cli/dist/bin/whisper.js collab stop --workspace "$WORKSPACE"
show_debug_snapshot
