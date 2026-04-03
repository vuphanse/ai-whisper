# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 5 delivers a CLI-first MVP with the `whisper collab` workflow, real Codex and Claude providers, broker-backed turn routing, collab lifecycle commands, and active-thread-aware tell behavior.

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
- `packages/cli` - `whisper` command surface with collab lifecycle and tell commands
- `packages/adapter-codex` - Codex provider
- `packages/adapter-claude` - Claude provider

## MVP Commands

```bash
whisper collab start
whisper collab status
whisper collab tell codex --action review_plan --artifact docs/plan.md "review this plan"
whisper collab stop
```

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7: attach, recovery, and operator tooling
