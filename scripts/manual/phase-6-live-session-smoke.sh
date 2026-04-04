#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVIDER=""
MODE="broker"
MESSAGE="hello"
ATTEMPT=""
PROBE_PAYLOAD="plain"
WORKSPACE="$REPO_ROOT"
WAIT_MS="${AI_WHISPER_SMOKE_WAIT_MS:-1500}"
TIMEOUT_MS="${AI_WHISPER_SMOKE_TIMEOUT_MS:-15000}"
PROBE_SETTLE_MS="${AI_WHISPER_SMOKE_PROBE_SETTLE_MS:-2000}"
NO_BUILD=0

usage() {
  cat <<'EOF'
Usage: phase-6-live-session-smoke.sh --provider <codex|claude> [options]

Options:
  --provider <codex|claude>   Provider to smoke test
  --mode <broker|probe>       Run the full broker smoke or plain-message probe
  --message <text>            Probe message payload when --mode probe is used
  --attempt <name>            Run a single named probe attempt
  --probe-payload <kind>      Probe payload: plain, framed-minimal, or broker-current
  --workspace <path>          Working directory to open in the live session
  --wait-ms <ms>              Delay before broker prompt injection
  --timeout-ms <ms>           Maximum wait for framed reply
  --probe-settle-ms <ms>      Delay after each probe attempt before capture
  --no-build                  Skip pnpm build
  --help                      Show this message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      PROVIDER="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --attempt)
      ATTEMPT="${2:-}"
      shift 2
      ;;
    --probe-payload)
      PROBE_PAYLOAD="${2:-}"
      shift 2
      ;;
    --workspace)
      WORKSPACE="${2:-}"
      shift 2
      ;;
    --wait-ms)
      WAIT_MS="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --probe-settle-ms)
      PROBE_SETTLE_MS="${2:-}"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
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

if [[ -z "$PROVIDER" ]]; then
  echo "--provider is required" >&2
  usage >&2
  exit 1
fi

if [[ "$PROVIDER" != "codex" && "$PROVIDER" != "claude" ]]; then
  echo "--provider must be codex or claude" >&2
  exit 1
fi

if [[ "$MODE" != "broker" && "$MODE" != "probe" ]]; then
  echo "--mode must be broker or probe" >&2
  exit 1
fi

if [[ "$PROBE_PAYLOAD" != "plain" && "$PROBE_PAYLOAD" != "framed-minimal" && "$PROBE_PAYLOAD" != "broker-current" ]]; then
  echo "--probe-payload must be plain, framed-minimal, or broker-current" >&2
  exit 1
fi

# Note: --probe-payload framed-minimal and broker-current are DEBUG ONLY modes.
# They exercise PTY submission mechanics using inline or file-backed payloads
# and are not the supported broker-delivery path used in production.

cd "$REPO_ROOT"

if [[ "$NO_BUILD" -ne 1 ]]; then
  echo "+ pnpm build"
  pnpm build
fi

NODE_ARGS=(
  scripts/manual/phase-6-live-session-smoke.mjs
  --provider "$PROVIDER"
  --mode "$MODE"
  --message "$MESSAGE"
  --probe-payload "$PROBE_PAYLOAD"
  --workspace "$WORKSPACE"
  --wait-ms "$WAIT_MS"
  --timeout-ms "$TIMEOUT_MS"
  --probe-settle-ms "$PROBE_SETTLE_MS"
)

if [[ -n "$ATTEMPT" ]]; then
  NODE_ARGS+=(--attempt "$ATTEMPT")
fi

echo "+ node ${NODE_ARGS[*]}"
node "${NODE_ARGS[@]}"
