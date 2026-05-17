#!/usr/bin/env bash
# Headless end-to-end smoke for the relocated shared-SQLite runtime.
#
# Exercises the seams unit tests mock: real spawnBrokerDaemon, two-phase
# pid=NULL reservation, waitForReady polling, resolveCollab, recover reclaim,
# soft-stop, and multi-collab isolation in one shared state.db. No providers,
# no tmux, no LLM. Fully isolated; never touches the real ~/.ai-whisper.
#
# Usage: scripts/manual/runtime-relocation-smoke.sh
set -uo pipefail

case "${1:-}" in
  --help|-h)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/manual/_probe-shared-db.sh
source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"

DB="$(probe_state_db)"
WS_A="$(cd "$(mktemp -d /tmp/aiw-smoke-wsA-XXXX)" && pwd -P)"
WS_B="$(cd "$(mktemp -d /tmp/aiw-smoke-wsB-XXXX)" && pwd -P)"
PASS=0
FAIL=0
declare -a PIDS=()

ok() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}
bad() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}
q() { sqlite3 "$DB" "$1"; }
alive() { kill -0 "$1" 2>/dev/null; }
whisper() { node "$WHISPER_BIN" "$@"; }

cleanup() {
  echo "--- teardown ---"
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill -9 "$p" 2>/dev/null && echo "  killed $p"
  done
  pkill -9 -f "AI_WHISPER_STATE_ROOT=$AI_WHISPER_STATE_ROOT" 2>/dev/null || true
  rm -rf "$WS_A" "$WS_B" "$AI_WHISPER_STATE_ROOT"
  echo "  removed temp dirs; ~/.ai-whisper untouched"
}
trap cleanup EXIT

echo "STATE_ROOT=$AI_WHISPER_STATE_ROOT"
echo "WS_A=$WS_A"
echo "WS_B=$WS_B"
echo

echo "=== 1. start collab A (--no-launch) ==="
OUT_A="$(whisper collab start --workspace "$WS_A" --no-launch 2>&1)"
echo "$OUT_A"
CID_A="$(echo "$OUT_A" | sed -n 's/^Collab started: \(.*\) (launch.*/\1/p')"
[ -n "$CID_A" ] && ok "start A returned collab id ($CID_A)" || {
  bad "start A produced no collab id"
  exit 1
}
echo "$OUT_A" | grep -q "launch: none" && ok "A launch mode = none" || bad "A launch mode not none"

echo "=== 2. shared DB rows for A ==="
[ "$(q "SELECT count(*) FROM workspace;")" -ge 1 ] && ok "workspace row exists" || bad "no workspace row"
WID_A="$(q "SELECT workspace_id FROM collab WHERE collab_id='$CID_A';")"
[ -n "$WID_A" ] && ok "collab A.workspace_id set ($WID_A)" || bad "collab A.workspace_id NULL"
ST_A="$(q "SELECT status FROM collab WHERE collab_id='$CID_A';")"
[ "$ST_A" = active ] && ok "collab A status=active" || bad "collab A status=$ST_A"
LM_A="$(q "SELECT launch_mode FROM collab WHERE collab_id='$CID_A';")"
[ "$LM_A" = none ] && ok "collab A launch_mode=none persisted" || bad "collab A launch_mode=$LM_A"
read -r PID_A HOST_A PORT_A <<<"$(q "SELECT pid||' '||host||' '||port FROM broker_daemon WHERE collab_id='$CID_A';")"
[ -n "${PID_A:-}" ] && [ "$PID_A" -gt 0 ] && ok "broker_daemon A pid=$PID_A (real, >0)" || bad "broker_daemon A pid invalid: '${PID_A:-}'"
PIDS+=("$PID_A")
alive "$PID_A" && ok "daemon A process alive" || bad "daemon A process NOT alive"
PST_A="$(q "SELECT pid_start_time FROM broker_daemon WHERE collab_id='$CID_A';")"
[ -n "$PST_A" ] && ok "broker_daemon A pid_start_time recorded" || bad "broker_daemon A pid_start_time empty"
curl -fsS "http://$HOST_A:$PORT_A/health" >/dev/null 2>&1 && ok "daemon A /health 200 on $HOST_A:$PORT_A" || bad "daemon A /health failed on $HOST_A:$PORT_A"

echo "=== 3. status A resolves by cwd (real resolveCollab) ==="
S_A="$(cd "$WS_A" && node "$WHISPER_BIN" collab status 2>&1)"
echo "$S_A" | grep -q "status: active" && ok "status (cwd) reports active" || bad "status (cwd) not active: $S_A"
echo "$S_A" | grep -q "launch: none" && ok "status reports launch: none" || bad "status missing launch: none"

echo "=== 4. start collab B in a second workspace (multi-collab isolation) ==="
OUT_B="$(whisper collab start --workspace "$WS_B" --no-launch 2>&1)"
echo "$OUT_B"
CID_B="$(echo "$OUT_B" | sed -n 's/^Collab started: \(.*\) (launch.*/\1/p')"
[ -n "$CID_B" ] && [ "$CID_B" != "$CID_A" ] && ok "B distinct collab id ($CID_B)" || bad "B collab id missing or == A"
WID_B="$(q "SELECT workspace_id FROM collab WHERE collab_id='$CID_B';")"
[ -n "$WID_B" ] && [ "$WID_B" != "$WID_A" ] && ok "B distinct workspace_id ($WID_B)" || bad "B workspace_id missing or == A"
read -r PID_B PORT_B <<<"$(q "SELECT pid||' '||port FROM broker_daemon WHERE collab_id='$CID_B';")"
PIDS+=("$PID_B")
[ "$PORT_B" != "$PORT_A" ] && ok "B distinct port ($PORT_B vs A $PORT_A)" || bad "B port collides with A"
alive "$PID_A" && alive "$PID_B" && ok "both daemons alive simultaneously (A=$PID_A B=$PID_B)" || bad "not both daemons alive"

echo "=== 5. kill -9 A's daemon, then recover (reclaim path) ==="
kill -9 "$PID_A"
sleep 1
alive "$PID_A" && bad "A daemon still alive after kill -9" || ok "A daemon killed (simulated broker loss)"
R_OUT="$(whisper collab recover --collab "$CID_A" 2>&1)"
echo "$R_OUT"
echo "$R_OUT" | grep -q "Collab recovered: $CID_A" && ok "recover reported success" || bad "recover did not report success"
PID_A2="$(q "SELECT pid FROM broker_daemon WHERE collab_id='$CID_A';")"
PIDS+=("$PID_A2")
[ -n "$PID_A2" ] && [ "$PID_A2" != "$PID_A" ] && alive "$PID_A2" && ok "recovered daemon has NEW live pid ($PID_A2 != $PID_A)" || bad "recovered pid invalid: '$PID_A2'"
[ "$(q "SELECT count(*) FROM recovery_state WHERE collab_id='$CID_A';")" -ge 1 ] &&
  ok "recovery_state row written (state=$(q "SELECT state FROM recovery_state WHERE collab_id='$CID_A';"))" ||
  bad "no recovery_state row after recover"
echo "$(cd "$WS_A" && node "$WHISPER_BIN" collab status 2>&1)" | grep -q "status: active" &&
  ok "A status active after recover" || bad "A not active after recover"

echo "=== 6. stop A (--collab); B must survive (no cross-collab clobber) ==="
whisper collab stop --collab "$CID_A" 2>&1
sleep 1
alive "$PID_A2" && bad "A recovered daemon still alive after stop" || ok "A daemon torn down by stop"
[ "$(q "SELECT status FROM collab WHERE collab_id='$CID_A';")" = stopped ] && ok "collab A status=stopped" || bad "collab A not stopped"
[ -n "$(q "SELECT stopped_at FROM collab WHERE collab_id='$CID_A';")" ] && ok "collab A.stopped_at set" || bad "collab A.stopped_at NULL"
[ "$(q "SELECT count(*) FROM broker_daemon WHERE collab_id='$CID_A';")" = 0 ] && ok "broker_daemon A row deleted" || bad "broker_daemon A row lingers"
alive "$PID_B" && ok "B daemon STILL alive after A stopped (isolation holds)" || bad "B daemon died when A stopped"
[ "$(q "SELECT count(*) FROM broker_daemon WHERE collab_id='$CID_B';")" = 1 ] && ok "broker_daemon B row intact" || bad "broker_daemon B row affected"

echo "=== 7. stop B by cwd resolution ==="
(cd "$WS_B" && node "$WHISPER_BIN" collab stop) 2>&1
sleep 1
alive "$PID_B" && bad "B daemon still alive after stop" || ok "B daemon torn down (cwd-resolved stop)"
[ "$(q "SELECT status FROM collab WHERE collab_id='$CID_B';")" = stopped ] && ok "collab B status=stopped" || bad "collab B not stopped"

echo
echo "=== RESULT: $PASS passed, $FAIL failed ==="
exit $FAIL
