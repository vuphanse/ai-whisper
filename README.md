# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 6 is complete and delivers the in-session relay workflow on top of the Phase 5 CLI-first MVP: `whisper collab` startup and lifecycle commands, real Codex and Claude providers, broker-backed turn routing, active-thread-aware relay semantics, and concise inline acknowledgement and reply summaries inside active sessions.

## Requirements

Phase 6 interactive sessions require `node-pty`, which is a native dependency. Local installs need a working native build toolchain available to `pnpm install` so the PTY binding can compile or load correctly.

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

## Typical Workflow

```bash
whisper collab start
```

Then inside a live session:

```text
@@codex review this plan
@@claude[new] implement the agreed changes
```

And for a brand-new thread that needs explicit artifacts:

```bash
whisper collab tell --target codex --action review_plan --artifact docs/plan.md "review this plan"
```

Other lifecycle commands:

```bash
whisper collab status
whisper collab stop
```

### Attach workflow (Phase 7A)

Use `--no-launch` when you want to start the broker without immediately spawning provider sessions, then attach each provider manually:

```bash
whisper collab start --no-launch
whisper collab attach codex
whisper collab attach claude
```

Each `attach` command prints a snippet to run from the corresponding provider terminal. In Phase 7A, that snippet starts the local `attach-session` bridge process from that terminal; it does not hook into or recover the provider's internal conversation state.

If a role is already bound and you need to replace it:

```bash
whisper collab rebind codex
```

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow (completed)
- Phase 7: attach, recovery, and operator tooling
