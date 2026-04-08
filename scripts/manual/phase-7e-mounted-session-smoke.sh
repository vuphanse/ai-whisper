#!/usr/bin/env bash
# Manual validation checklist for Phase 7E mounted-session relay.
# Run this script to print the smoke checklist to stdout.

cat <<'EOF'
Manual validation checklist for mounted-session relay:
  Build first: pnpm build
  Use node packages/cli/dist/bin/whisper.js for all commands below
  Preferred full-flow probe:
    ./scripts/manual/phase-7e-mounted-turn-handoff-probe.sh --reset-runtime
  Probe notes:
    - The probe starts relay-monitor plus both mounted providers in tmux
    - Both mounted providers set AI_WHISPER_DEBUG_INPUT_LOG for byte-level debugging
    - Inspect the generated .ai-whisper/manual/... logs after the run
  1. Start broker only with node packages/cli/dist/bin/whisper.js collab start --no-launch
  2. In one iTerm shell, run node packages/cli/dist/bin/whisper.js collab mount codex
  3. In a second iTerm shell, run node packages/cli/dist/bin/whisper.js collab mount claude
  4. Confirm each provider launches automatically in its respective terminal
  5. From the codex terminal, type @@claude ... and verify preview, acknowledgement, and reply-summary rendering
  6. From the claude terminal, type @@codex ... and verify the same
  7. Run node packages/cli/dist/bin/whisper.js collab status / inspect from another shell and confirm [mounted] for both roles
  8. Recover and reconnect a mounted role and confirm the mounted path is reused
EOF
