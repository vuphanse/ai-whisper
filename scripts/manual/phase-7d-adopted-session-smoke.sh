#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: phase-7d-adopted-session-smoke.sh --provider <codex|claude> [--workspace <path>]

Manual validation checklist for adopted-session attach:

  1. Run whisper collab start --no-launch
  2. Start the provider manually in iTerm
  3. Press Ctrl+Z to suspend the provider
  4. Run whisper collab attach <role> --adopt-current-tty
  5. Confirm the shell returns and jobs still shows the stopped provider
  6. Run fg to resume the original provider session
  7. Confirm the original provider session resumes normally
  8. Send a relay and verify relay rendering (preview, acknowledgement, reply-summary)
  9. Run whisper collab status and confirm the role shows as adopted
  10. Run whisper collab inspect and confirm tty path is visible

Validation points:
  - Shell remains usable after attach (no raw-mode takeover)
  - fg resumes the original provider process
  - relay rendering (preview, acknowledgement, reply-summary) works on the adopted session
  - status and inspect show the role as adopted with tty path
  - If the adopted agent dies, the role degrades visibly
EOF
}

PROVIDER=""
WORKSPACE="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PROVIDER" ]]; then
  usage
  exit 1
fi

echo "=== Phase 7D Adopted Session Smoke Test ==="
echo "Provider: $PROVIDER"
echo "Workspace: $WORKSPACE"
echo ""
echo "Follow the manual checklist above."
echo "This script does not automate the flow — it documents the validation steps."
