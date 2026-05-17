#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="${AI_WHISPER_MANUAL_WORKSPACE:-$(mktemp -d /tmp/ai-whisper-forensic-XXXXXX)}"
# shellcheck source=scripts/manual/_probe-shared-db.sh
source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"
BROKER_DB="$(probe_state_db)"
COLLAB_ID=""

step() {
  printf '\n== %s ==\n' "$1"
}

run_cmd() {
  printf '+ %s\n' "$*"
  "$@"
}

ensure_clean_workspace() {
  printf '\n-- stopping any prior collab (best-effort) --\n'
  probe_stop_if_active
}

dump_sql() {
  local label="$1"
  local sql="$2"
  if [[ -f "$BROKER_DB" ]]; then
    printf '\n-- sqlite: %s --\n' "$label"
    sqlite3 -header -column "$BROKER_DB" "$sql" || true
  else
    printf '\n-- sqlite missing: %s --\n' "$BROKER_DB"
  fi
}

dump_all_tables() {
  dump_sql "collab" 'SELECT * FROM collab;'
  dump_sql "broker_daemon" 'SELECT * FROM broker_daemon;'
  dump_sql "session" 'SELECT * FROM session;'
  dump_sql "thread" 'SELECT * FROM thread;'
  dump_sql "work_item" 'SELECT * FROM work_item;'
  dump_sql "reply" 'SELECT * FROM reply;'
  dump_sql "companion_session" 'SELECT * FROM companion_session;'
  dump_sql "event_log" 'SELECT event_id, event_type, collab_id, created_at, schema_version FROM event_log ORDER BY rowid;'
}

show_snapshot() {
  dump_all_tables
}

cleanup_notice() {
  printf '\n== Script finished ==\n'
  printf 'Workspace kept at: %s\n' "$WORKSPACE"
}
trap cleanup_notice EXIT

cd "$REPO_ROOT"

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

step "Start collab"
printf '+ node packages/cli/dist/bin/whisper.js collab start --workspace %s\n' "$WORKSPACE"
node packages/cli/dist/bin/whisper.js collab start --workspace "$WORKSPACE" | tee "$WORKSPACE/start.log"
COLLAB_ID="$(probe_active_collab_id "$WORKSPACE/start.log")"
printf 'COLLAB_ID=%s\n' "${COLLAB_ID:-<unknown>}"
show_snapshot

step "Tell Codex"
run_cmd node packages/cli/dist/bin/whisper.js collab tell ${COLLAB_ID:+--collab "$COLLAB_ID"} \
  --target codex \
  --action review_plan \
  --artifact "$WORKSPACE/plan.md" \
  "Review this plan and return a concise review."
show_snapshot

step "Tell Claude"
run_cmd node packages/cli/dist/bin/whisper.js collab tell ${COLLAB_ID:+--collab "$COLLAB_ID"} \
  --target claude \
  --action answer_question \
  "Summarize the current thread state in one sentence."
show_snapshot

step "Stop collab"
run_cmd node packages/cli/dist/bin/whisper.js collab stop ${COLLAB_ID:+--collab "$COLLAB_ID"}
show_snapshot
