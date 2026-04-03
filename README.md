# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 2 adds shared broker contracts, SQLite bootstrap, and a minimal broker runtime with health/status endpoints.

## Workspace Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## Package Layout

- `packages/shared` - shared IDs, literals, and versioned schemas
- `packages/cli` - future `whisper` command surface
- `packages/broker` - local broker runtime and storage bootstrap
- `packages/companion-core` - future companion runtime
- `packages/adapter-codex` - future Codex provider
- `packages/adapter-claude` - future Claude provider

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: real user workflow
