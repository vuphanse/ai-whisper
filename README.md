# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 6 is complete and delivers the in-session relay workflow on top of the Phase 5 CLI-first MVP: `whisper collab` startup and lifecycle commands, real Codex and Claude providers, broker-backed turn routing, active-thread-aware relay semantics, and concise inline acknowledgement and reply summaries inside active sessions.

When running from this repo checkout, build first with `pnpm build` and invoke the CLI as `node packages/cli/dist/bin/whisper.js ...`. The `whisper ...` examples below assume a packaged or globally installed CLI.

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

By default, `collab start` prefers `tmux` and attaches your current terminal into the collab session with split panes when `tmux` is available. Use `--no-tmux` to launch separate terminal windows instead. Use `--no-launch` when you only want the broker and plan to `mount` or legacy-`attach` providers manually.

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

### Terminal-first mounted sessions (Phase 7E)

The preferred workflow for inline `@@` relay support. `whisper collab mount` claims the current iTerm shell as the managed session surface and launches the provider automatically:

1. `whisper collab start --no-launch`
2. in one iTerm tab, run `whisper collab mount codex`
3. in a second iTerm tab, run `whisper collab mount claude`
4. from the Codex tab, type `@@claude <instruction>` to relay to Claude with inline acknowledgement and reply

Mounted sessions keep `ai-whisper` as the terminal owner, so the live-session relay parser can intercept `@@...` input. Recovery and reconnect default to the mounted path when the previous binding was mounted.

#### Baton handoff workflow

Use mounted sessions when you want the visible Codex and Claude tabs to be the real workflow actors.

Example real use case:

- Claude reviews plan and decides Codex should implement next step
- Claude sends handoff from visible Claude tab
- Claude waits while Codex owns turn
- Codex does work in visible Codex tab
- Codex hands result back to Claude
- Claude reviews result, amends request if needed, or sends next handoff

Recommended startup:

```bash
whisper collab start --no-launch
```

Then in two normal iTerm tabs:

```bash
whisper collab mount codex
whisper collab mount claude
```

Send work from current owner:

```text
@@codex implement phase 7e handback flow
@@claude review mounted relay acceptance UX
```

What happens next:

- ownership flips immediately to target provider
- sender becomes waiting side and normal typing is blocked
- owner sees local handoff card inside mounted tab
- only one unresolved handoff is allowed at a time

Owner controls inside mounted tab:

- `a` accepts handoff immediately and injects original request into visible session
- `e` opens local editor first so owner can amend request before accepting
- `d` declines handoff and releases sender
- `space` defers handoff but keeps sender waiting

After accept, owner works normally in visible provider session. When ready to return turn:

- press `h` when mounted runtime shows `Ready to hand back`
- press `Ctrl+H` to force handback immediately if the readiness hint does not appear
- runtime tries to capture latest visible response
- if copied response looks right, press `Enter` to confirm handback
- if capture is empty or not usable, local composer opens so owner can write handback text manually

Practical guidance:

- use `mount`, not `attach --adopt-current-tty`, for this workflow
- think of relay as strict baton pass, not two active sessions typing at once
- send compact, explicit tasks so owner can accept quickly or amend locally
- use handback to return result summary or next-step request to other side
- if handoff stays deferred, sender remains blocked until owner declines, cancels, or hands turn back

### Adopt existing provider sessions (Phase 7D)

Legacy workflow for sessions started before `whisper collab mount` existed. Use when you have already started a provider and want to bind it without relaunching:

1. `whisper collab start --no-launch`
2. start `codex` or `claude` manually
3. press `Ctrl+Z` to suspend the provider
4. run `whisper collab attach codex --adopt-current-tty`
5. verify the shell returns
6. run `fg` to resume the original provider

The adopted session keeps the provider's terminal surface intact. The background daemon handles broker work items queued via `whisper collab tell` from another terminal.

**Limitation**: `attach --adopt-current-tty` does not support inline @@ relay directives. The provider process owns the terminal's input after `fg`, and the background daemon cannot intercept keystrokes. Use `whisper collab tell --target codex "review this"` from a separate terminal instead. If you need inline relay, use `whisper collab mount` instead.

The `--adopt-current-tty` flag is also available on `rebind` and `reconnect`. Use `--tty <path>` to adopt a specific device path instead. The two flags are mutually exclusive.

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow (completed)
- Phase 7: attach, recovery, and operator tooling
