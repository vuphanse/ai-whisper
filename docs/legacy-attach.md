# Legacy Attach Mode

> **Status: shelved.** The `whisper collab attach`, `whisper collab rebind`, and `--adopt-current-tty` flows have been removed from the CLI surface. Their source lives in [`packages/cli/deprecated/`](../packages/cli/deprecated) as a reference for a future redesign. This document captures the original flows verbatim so the design context is not lost.
>
> For everyday use, prefer `whisper collab mount` (see [README.md](../README.md#terminal-first-mounted-sessions-phase-7e)). The mounted path is the only surface that supports inline `@@` relay directives and the relay orchestrator.

The legacy attach mode shipped across two phases:

- **Phase 7A — attach workflow** (snippet-based)
- **Phase 7D — adopt existing provider sessions** (`--adopt-current-tty`)

Original design specs (still in repo for historical reference):

- [`docs/superpowers/specs/2026-04-05-ai-whisper-phase-7a-attach-and-rebind-design.md`](superpowers/specs/2026-04-05-ai-whisper-phase-7a-attach-and-rebind-design.md)
- [`docs/superpowers/specs/2026-04-06-ai-whisper-phase-7d-adopt-existing-provider-sessions-design.md`](superpowers/specs/2026-04-06-ai-whisper-phase-7d-adopt-existing-provider-sessions-design.md)

## Why it was shelved

- `attach --adopt-current-tty` cannot intercept inline `@@` relay keystrokes after `fg` returns terminal ownership to the provider, so the orchestrated handoff loop never starts from that surface.
- The snippet flow takes over the terminal as the `ai-whisper` live-session surface without recovering the provider's internal conversation state — a partial overlap with `mount` that confused users.
- No one was using the legacy paths in practice; `mount` is the preferred entry point for every supported workflow.

The broker-side claim plumbing (`attach-claim` repository, `attachClaimSchema`, `attachTargetModes`) is retained because `mount` and `reconnect` still issue claims through it. A future redesign may rename these.

## Phase 7A — Attach workflow (legacy)

Use `--no-launch` when you want to start the broker without immediately spawning provider sessions, then attach each provider manually:

```bash
whisper collab start --no-launch
whisper collab attach codex
whisper collab attach claude
```

Each `attach` command prints a snippet to run from a shell prompt in the terminal you want to dedicate to that role. The snippet starts the local `attach-session` bridge process and takes over that terminal as the `ai-whisper` live-session surface; it does not hook into or recover the provider's internal conversation state.

This flow does not support pasting the snippet into an already-running Codex or Claude interactive prompt. If you do that, the provider will treat it as normal prompt text. The supported attach flow is to start with `whisper collab start --no-launch`, then run the printed snippet from a normal shell prompt in a terminal that will become the attached session surface.

### Rebind (legacy)

If a role was already bound and you needed to replace it:

```bash
whisper collab rebind codex
```

`rebind` defaulted to the same snippet flow and accepted the same `--adopt-current-tty` / `--tty` flags as `attach`.

## Phase 7D — Adopt existing provider sessions (legacy)

Used when a provider had already been started and you wanted to bind it without relaunching:

1. `whisper collab start --no-launch`
2. start `codex` or `claude` manually
3. press `Ctrl+Z` to suspend the provider
4. run `whisper collab attach codex --adopt-current-tty`
5. verify the shell returns
6. run `fg` to resume the original provider

The adopted session kept the provider's terminal surface intact. A background daemon handled broker work items queued via `whisper collab tell` from another terminal.

**Limitation**: `attach --adopt-current-tty` did not support inline `@@` relay directives. The provider process owned the terminal's input after `fg`, and the background daemon could not intercept keystrokes. Operators had to use `whisper collab tell --target codex "review this"` from a separate terminal instead.

The `--adopt-current-tty` flag was also available on `rebind` and `reconnect`. `--tty <path>` could adopt a specific device path instead. The two flags were mutually exclusive.

## Legacy reconnect modes

`whisper collab reconnect` previously supported four target modes:

- `mount_current_tty` — mounted reconnect (still supported; now the only mode)
- `snippet_shell` — print an `attach-session` snippet for a fresh terminal
- `adopt_current_tty` — adopt the current tty after `Ctrl+Z`
- `explicit_tty` — adopt a specific `/dev/tty*` path passed via `--tty`

When invoked without an explicit `--targetMode`, reconnect would default to the mode of the previous binding source (`mounted`, `adopted`, or `attached`/snippet). The snippet/adopt/explicit-tty paths were removed alongside the rest of the attach surface; the current `reconnect` always uses mounted mode.

## Shelved code map

| Original path | Deprecated path |
|---|---|
| `packages/cli/src/commands/collab/attach.ts` | `packages/cli/deprecated/commands/attach.ts` |
| `packages/cli/src/commands/collab/rebind.ts` | `packages/cli/deprecated/commands/rebind.ts` |
| `packages/cli/src/runtime/attach-snippet.ts` | `packages/cli/deprecated/runtime/attach-snippet.ts` |
| `packages/cli/src/runtime/adopted-session-daemon.ts` | `packages/cli/deprecated/runtime/adopted-session-daemon.ts` |
| `packages/cli/src/runtime/adopted-interactive-session.ts` | `packages/cli/deprecated/runtime/adopted-interactive-session.ts` |
| `packages/cli/src/runtime/adopt-session-main.ts` | `packages/cli/deprecated/runtime/adopt-session-main.ts` |
| `packages/cli/src/runtime/adopted-session-target.ts` | `packages/cli/deprecated/runtime/adopted-session-target.ts` |
| `packages/cli/src/bin/attach-session.ts` | `packages/cli/deprecated/bin/attach-session.ts` |
| `packages/cli/src/bin/adopt-session.ts` | `packages/cli/deprecated/bin/adopt-session.ts` |

Tests for these flows were moved to `packages/cli/deprecated/test/` and are excluded from the test runner (vitest's `test/**/*.test.ts` glob does not reach them).

The generic `resolveCurrentTty` helper, previously in `adopted-session-target.ts`, was extracted to `packages/cli/src/runtime/current-tty.ts` because `mount` still depends on it.
