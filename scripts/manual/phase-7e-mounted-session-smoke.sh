#!/usr/bin/env bash
# Manual validation checklist for Phase 7E mounted-session relay.
# Run this script to print the smoke checklist to stdout.

cat <<'EOF'
Manual validation checklist for mounted-session relay:
  1. Start broker only with whisper collab start --no-launch
  2. In a normal iTerm shell, run whisper collab mount <role>
  3. Confirm the correct provider launches automatically in the same terminal
  4. Type @@codex ... or @@claude ... and verify preview, acknowledgement, and reply-summary rendering
  5. Run whisper collab status / inspect from another shell and confirm [mounted]
  6. Recover and reconnect the mounted role and confirm the mounted path is reused
EOF
