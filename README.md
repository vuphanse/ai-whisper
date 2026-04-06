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

Each `attach` command prints a snippet to run from a shell prompt in the terminal you want to dedicate to that role. In Phase 7A, that snippet starts the local `attach-session` bridge process and takes over that terminal as the `ai-whisper` live-session surface; it does not hook into or recover the provider's internal conversation state.

This means Phase 7A does not yet support pasting the snippet into an already-running Codex or Claude interactive prompt. If you do that, the provider will treat it as normal prompt text. The current supported attach flow is to start with `whisper collab start --no-launch`, then run the printed snippet from a normal shell prompt in a terminal that will become the attached session surface.

If a role is already bound and you need to replace it:

```bash
whisper collab rebind codex
```

### Recovery workflow (Phase 7B)

If the current workspace collab still exists but the broker is gone or unusable:

```bash
whisper collab recover
whisper collab reconnect codex
whisper collab reconnect claude
```

Recovery restores durable collab state pessimistically. Previously bound roles come back degraded and must be reconnected explicitly. For roles that were originally bound via `--adopt-current-tty`, reconnect defaults to adoption mode — suspend the provider with `Ctrl+Z`, run `whisper collab reconnect <role>`, then `fg`. For snippet-based roles, reconnect prints a shell snippet as before. Recovery also returns the broker idle; interrupted queued work does not resume automatically.

### Operator monitoring workflow (Phase 7C1)

Use the quick snapshot first:

```bash
whisper collab status
```

Inspect the active thread in more detail:

```bash
whisper collab inspect
```

Use live monitoring when a collab is active:

```bash
whisper collab inspect --watch
```

`inspect` is read-only. It shows the active thread, recent work items, recent replies, and recent failed or `recovery_blocked` activity with truncated previews by default.

### Adopt existing provider sessions (Phase 7D)

For the macOS/iTerm-first manual workflow:

1. `whisper collab start --no-launch`
2. start `codex` or `claude` manually
3. press `Ctrl+Z` to suspend the provider
4. run `whisper collab attach codex --adopt-current-tty`
5. verify the shell returns
6. run `fg` to resume the original provider

The adopted session keeps the provider's terminal surface intact. The background daemon handles broker work items queued via `whisper collab tell` from another terminal.

**Limitation**: Inline `@@` relay directives (e.g., `@@codex review this`) are not available inside adopted sessions. The provider process owns the terminal's input after `fg`, and the background daemon cannot intercept keystrokes. Use `whisper collab tell --target codex "review this"` from a separate terminal instead.

The `--adopt-current-tty` flag is also available on `rebind` and `reconnect`. Use `--tty <path>` to adopt a specific device path instead. The two flags are mutually exclusive.

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow (completed)
- Phase 7: attach, recovery, and operator tooling
