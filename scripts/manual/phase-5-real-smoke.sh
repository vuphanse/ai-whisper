#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="${AI_WHISPER_MANUAL_WORKSPACE:-$(mktemp -d /tmp/ai-whisper-real-XXXXXX)}"
# shellcheck source=scripts/manual/_probe-shared-db.sh
source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"
STATE_DB="$(probe_state_db)"
COLLAB_ID=""

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
  substep "Stopping any prior collab (best-effort)"
  probe_stop_if_active
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

dump_state_db() {
  if [[ -f "$STATE_DB" ]]; then
    substep "Shared state DB rows ($STATE_DB)"
    sqlite3 -header -column "$STATE_DB" \
      "SELECT collab_id,status,workspace_id,launch_mode,created_at,stopped_at FROM collab;" || true
    sqlite3 -header -column "$STATE_DB" \
      "SELECT collab_id,host,port,pid,pid_start_time FROM broker_daemon;" || true
  else
    substep "Shared state DB not created yet ($STATE_DB)"
  fi
}

dump_process_state() {
  if [[ -n "$COLLAB_ID" && -f "$STATE_DB" ]]; then
    local broker_pid=""
    broker_pid="$(sqlite3 "$STATE_DB" "SELECT pid FROM broker_daemon WHERE collab_id='$COLLAB_ID';" 2>/dev/null || true)"
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
  run_cmd node packages/cli/dist/bin/whisper.js collab status ${COLLAB_ID:+--collab "$COLLAB_ID"}
}

tell_cmd() {
  run_cmd node packages/cli/dist/bin/whisper.js collab tell ${COLLAB_ID:+--collab "$COLLAB_ID"} "$@"
}

show_debug_snapshot() {
  dump_state_db
  if [[ -f "$STATE_DB" ]]; then
    substep "Shared state DB file"
    ls -lh "$STATE_DB"
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
printf 'STATE_ROOT=%s\n' "$AI_WHISPER_STATE_ROOT"
printf 'STATE_DB=%s\n' "$STATE_DB"
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
printf '+ node packages/cli/dist/bin/whisper.js collab start --workspace %s\n' "$WORKSPACE"
node packages/cli/dist/bin/whisper.js collab start --workspace "$WORKSPACE" | tee "$WORKSPACE/start.log"
COLLAB_ID="$(probe_active_collab_id "$WORKSPACE/start.log")"
printf 'COLLAB_ID=%s\n' "${COLLAB_ID:-<unknown>}"
show_debug_snapshot

step "Status after start"
status_cmd
show_debug_snapshot

step "Ask Codex to review the plan"
tell_cmd \
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
  --target claude \
  --action answer_question \
  "Summarize the current thread state in one sentence."
show_debug_snapshot

step "Final status"
status_cmd
show_debug_snapshot

step "Stop collab"
run_cmd node packages/cli/dist/bin/whisper.js collab stop ${COLLAB_ID:+--collab "$COLLAB_ID"}
show_debug_snapshot
