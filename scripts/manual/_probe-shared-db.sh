# shellcheck shell=bash
# Shared-SQLite-aware helpers for the manual probes.
#
# The runtime relocation moved all collab state out of
# "<workspace>/.ai-whisper/runtime/{current-collab.json,broker.sqlite}" into a
# single per-user "<state-root>/state.db" (env: AI_WHISPER_STATE_ROOT, default
# ~/.ai-whisper). This file replaces the per-workspace runtime plumbing the
# probes used to assume.
#
# Source it AFTER REPO_ROOT is set and BEFORE the first whisper invocation:
#   source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"

: "${REPO_ROOT:?_probe-shared-db.sh: REPO_ROOT must be set before sourcing}"

WHISPER_BIN="$REPO_ROOT/packages/cli/dist/bin/whisper.js"

# Each run gets its own isolated state root so a probe never disturbs the
# developer's real ~/.ai-whisper/state.db. Pin AI_WHISPER_PROBE_STATE_ROOT to
# run against a specific (e.g. the real) root instead.
if [[ -n "${AI_WHISPER_PROBE_STATE_ROOT:-}" ]]; then
  PROBE_STATE_ROOT="$AI_WHISPER_PROBE_STATE_ROOT"
  PROBE_STATE_ROOT_ISOLATED=0
else
  PROBE_STATE_ROOT="$(mktemp -d "/tmp/ai-whisper-probe-state-XXXXXX")"
  PROBE_STATE_ROOT_ISOLATED=1
fi
mkdir -p "$PROBE_STATE_ROOT"
export AI_WHISPER_STATE_ROOT="$PROBE_STATE_ROOT"
PROBE_STATE_DB="$PROBE_STATE_ROOT/state.db"

# Absolute path of the shared SQLite the CLI/broker will use this run.
probe_state_db() { printf '%s' "$PROBE_STATE_DB"; }

# Env prefix that must be embedded in every tmux pane command so panes spawned
# under an already-running tmux server still resolve the probe's isolated DB.
# Mirrors the production launcher's buildBrokerEnvPrefix contract.
probe_env_prefix() { printf "AI_WHISPER_STATE_ROOT=%q" "$AI_WHISPER_STATE_ROOT"; }

# Best-effort stop. `collab stop` is idempotent and prints "No active collab."
# when there is nothing to stop. Optional arg: explicit collab id.
probe_stop_if_active() {
  if [[ -n "${1:-}" ]]; then
    node "$WHISPER_BIN" collab stop --collab "$1" >/dev/null 2>&1 || true
  else
    node "$WHISPER_BIN" collab stop >/dev/null 2>&1 || true
  fi
}

# --reset-runtime equivalent: stop any active collab then wipe the isolated DB.
# Wiping is skipped when running against a pinned (non-isolated) root.
probe_reset_runtime() {
  probe_stop_if_active "${1:-}"
  if [[ "$PROBE_STATE_ROOT_ISOLATED" -eq 1 ]]; then
    rm -f "$PROBE_STATE_DB" "$PROBE_STATE_DB-wal" "$PROBE_STATE_DB-shm"
  fi
}

# Resolve the collab id. Prefers parsing a start.log
# ("Collab started: <id> (launch: ...)"); falls back to the newest active row.
probe_active_collab_id() {
  if [[ -n "${1:-}" && -f "$1" ]]; then
    sed -n 's/^Collab started: \(.*\) (launch.*/\1/p' "$1" | tail -1
    return
  fi
  sqlite3 "$PROBE_STATE_DB" \
    "SELECT collab_id FROM collab WHERE status='active' ORDER BY created_at DESC LIMIT 1;" \
    2>/dev/null || true
}

# echoes "host port" for a collab id (empty if no live daemon row).
probe_broker_endpoint() {
  [[ -n "${1:-}" ]] || return 0
  sqlite3 "$PROBE_STATE_DB" \
    "SELECT host || ' ' || port FROM broker_daemon WHERE collab_id='$1';" \
    2>/dev/null || true
}

# Snapshot the shared DB + a readable row dump into $1 (replaces the old
# `cp current-collab.json` capture step).
probe_capture_state() {
  local dest="$1"
  mkdir -p "$dest"
  [[ -f "$PROBE_STATE_DB" ]] || return 0
  cp "$PROBE_STATE_DB" "$dest/state.db" 2>/dev/null || true
  {
    echo "== collab =="
    sqlite3 -header -column "$PROBE_STATE_DB" \
      "SELECT collab_id,status,workspace_id,launch_mode,created_at,stopped_at FROM collab;"
    echo
    echo "== broker_daemon =="
    sqlite3 -header -column "$PROBE_STATE_DB" \
      "SELECT collab_id,host,port,pid,pid_start_time FROM broker_daemon;"
    echo
    echo "== recovery_state =="
    sqlite3 -header -column "$PROBE_STATE_DB" "SELECT * FROM recovery_state;"
    echo
    echo "== session_attachment =="
    sqlite3 -header -column "$PROBE_STATE_DB" "SELECT * FROM session_attachment;"
  } >"$dest/state-db-dump.txt" 2>/dev/null || true
}
