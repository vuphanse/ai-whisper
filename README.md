# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 1 establishes the workspace, tooling, and package boundaries only.

## Workspace Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## Package Layout

- `packages/shared` - shared types and contract helpers
- `packages/cli` - future `whisper` command surface
- `packages/broker` - future local collaboration broker
- `packages/companion-core` - future companion runtime
- `packages/adapter-codex` - future Codex provider
- `packages/adapter-claude` - future Claude provider

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: real user workflow
