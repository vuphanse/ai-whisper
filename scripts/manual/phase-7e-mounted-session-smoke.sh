#!/usr/bin/env bash
# Manual validation checklist for Phase 7E mounted-session relay.
# Run this script to print the smoke checklist to stdout.

cat <<'EOF'
Manual validation checklist for mounted-session relay:
  1. Start broker only with whisper collab start --no-launch
  2. In one iTerm shell, run whisper collab mount codex
  3. In a second iTerm shell, run whisper collab mount claude
  4. Confirm each provider launches automatically in its respective terminal
  5. From the codex terminal, type @@claude ... and verify preview, acknowledgement, and reply-summary rendering
  6. From the claude terminal, type @@codex ... and verify the same
  7. Run whisper collab status / inspect from another shell and confirm [mounted] for both roles
  8. Recover and reconnect a mounted role and confirm the mounted path is reused
EOF
