# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 4 adds the generic companion runtime, provider contract, broker-side companion registration, and a deterministic mock provider for end-to-end testing.

## Workspace Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## Package Layout

- `packages/shared` - shared schemas for broker, provider, and companion contracts
- `packages/broker` - broker runtime, collaboration engine, and companion registration support
- `packages/companion-core` - generic companion runtime, provider registry, and mock provider
- `packages/cli` - future `whisper` command surface
- `packages/adapter-codex` - future Codex provider
- `packages/adapter-claude` - future Claude provider

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: real user workflow
