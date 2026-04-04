#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVIDER=""
WORKSPACE="$REPO_ROOT"
WAIT_MS="${AI_WHISPER_SMOKE_WAIT_MS:-1500}"
TIMEOUT_MS="${AI_WHISPER_SMOKE_TIMEOUT_MS:-15000}"
NO_BUILD=0

usage() {
  cat <<'EOF'
Usage: phase-6-live-session-smoke.sh --provider <codex|claude> [options]

Options:
  --provider <codex|claude>   Provider to smoke test
  --workspace <path>          Working directory to open in the live session
  --wait-ms <ms>              Delay before broker prompt injection
  --timeout-ms <ms>           Maximum wait for framed reply
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

cd "$REPO_ROOT"

if [[ "$NO_BUILD" -ne 1 ]]; then
  echo "+ pnpm build"
  pnpm build
fi

echo "+ node scripts/manual/phase-6-live-session-smoke.mjs --provider $PROVIDER --workspace $WORKSPACE --wait-ms $WAIT_MS --timeout-ms $TIMEOUT_MS"
node scripts/manual/phase-6-live-session-smoke.mjs \
  --provider "$PROVIDER" \
  --workspace "$WORKSPACE" \
  --wait-ms "$WAIT_MS" \
  --timeout-ms "$TIMEOUT_MS"
