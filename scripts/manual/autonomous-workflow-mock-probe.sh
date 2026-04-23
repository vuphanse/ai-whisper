#!/usr/bin/env bash
set -euo pipefail

# Autonomous-workflow mock-orchestrator probe wrapper.
# Delegates to autonomous-workflow-mock-probe.ts via tsx. No LLM cost.
# Exercises WorkflowDriver + applyOrchestratorVerdict + templating + git
# integration for happy, findings, escalate, resume, cancel scenarios.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCENARIO="all"
LOG_DIR=""

usage() {
  cat <<'EOF'
Usage: autonomous-workflow-mock-probe.sh [options]

Options:
  --scenario <name>    happy | findings | escalate | resume | cancel | all (default: all)
  --log-dir <path>     directory for probe-summary.txt (default: auto-generated under .ai-whisper/manual/)
  --help               show this message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) SCENARIO="${2:-}"; shift 2 ;;
    --log-dir)  LOG_DIR="${2:-}";  shift 2 ;;
    --help|-h)  usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT"

TSX="$REPO_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "tsx not found at $TSX — run 'pnpm install' first" >&2
  exit 1
fi

if [[ -z "$LOG_DIR" ]]; then
  TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
  LOG_DIR="$REPO_ROOT/.ai-whisper/manual/autonomous-workflow-mock-probe/$TIMESTAMP"
fi
mkdir -p "$LOG_DIR"

set +e
"$TSX" "$REPO_ROOT/scripts/manual/autonomous-workflow-mock-probe.ts" \
  --scenario "$SCENARIO" \
  --log-dir "$LOG_DIR" \
  | tee "$LOG_DIR/probe-stdout.txt"
EXIT="${PIPESTATUS[0]}"
set -e

echo
echo "Probe artifacts: $LOG_DIR"
exit "$EXIT"
