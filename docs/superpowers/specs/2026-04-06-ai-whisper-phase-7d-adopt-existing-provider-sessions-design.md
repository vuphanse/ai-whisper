# ai-whisper Phase 7D Adopt Existing Provider Sessions Design

**Date:** 2026-04-06

## Purpose

Phase 7A was meant to make `ai-whisper` usable with independently started provider sessions. The currently shipped implementation only partially satisfies that goal: `attach` and `reconnect` print a shell snippet that starts a foreground `attach-session` process and takes over that terminal. That works as a dedicated `ai-whisper` terminal surface, but it does not bind an already-running Codex or Claude prompt in place.

For the intended personal workflow, that gap is a blocker. The target user starts Codex and Claude manually in normal macOS iTerm shells, keeps those exact interactive sessions alive, and wants to bind them into a collab afterward without relaunching under `whisper` or switching to `tmux`.

This document defines the next incremental phase to close that gap.

## Roadmap Refinement

The roadmap should now be read as:

- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7A: shell-owned attach-session bootstrap for manual attach and reconnect
- Phase 7B: broker restart recovery
- Phase 7C1: active-thread monitoring and operator inspection
- Phase 7D: adopt already-running provider sessions on macOS/iTerm
- Later follow-up: broader portability, deeper diagnostics, and richer operator tooling

This keeps the original Phase 7A intent while acknowledging that the shipped shell snippet flow is not yet the final attach model for independently launched sessions.

## Phase 7D Goal

Phase 7D is successful when a user can:

1. start a collab with `whisper collab start --no-launch`
2. start Codex and Claude manually in normal macOS iTerm shells
3. suspend one of those provider sessions back to the shell with `Ctrl+Z`
4. run an attach command from that same shell to adopt the current terminal session
5. resume the provider with `fg`
6. continue using that exact same provider session as the bound live session for relay and broker work

The goal is not to relaunch the provider, replace the terminal surface, or require `tmux`. The goal is to keep the already-running provider session alive and bind it afterward.

## In Scope

Phase 7D includes:

- macOS-first support for adopting an already-running local provider session
- `whisper collab attach <role> --adopt-current-tty` as the primary user flow
- a later follow-up command shape `whisper collab attach <role> --tty <path>` on the same runtime model
- explicit role-to-terminal adoption with no auto-discovery
- a background adoption agent bound to a tty device instead of a foreground `attach-session` shell takeover
- a distinct binding source for adopted sessions
- status and inspect visibility for adopted sessions, including enough tty identity to debug them
- rebind and reconnect flows that reuse the same adopted-terminal targeting model
- pessimistic degradation when the adopted terminal or provider session becomes unavailable

## Out Of Scope

Phase 7D does not include:

- `tmux` as the required primary attach mechanism
- general cross-platform terminal adoption from day one
- automatic discovery of arbitrary local terminals
- provider-internal conversation recovery
- silent attach by pasting raw shell text into a running provider prompt
- remote terminal adoption
- multi-user terminal sharing
- deep provider-native slash-command integration as the core transport

Those may become later follow-up work if the personal macOS/iTerm workflow proves out.

## User Workflow

### Primary Flow: Adopt Current TTY

The primary operator flow is:

1. run `whisper collab start --no-launch`
2. start `codex` or `claude` manually in an iTerm shell
3. press `Ctrl+Z` to suspend that provider process back to the shell
4. run:

```bash
whisper collab attach codex --adopt-current-tty
```

5. the attach command captures the current tty path and starts the background adoption path
6. run `fg`
7. the exact same provider process resumes and becomes the bound live session for that collab role

This is the required first shipped flow.

### Follow-Up Flow: Explicit TTY Targeting

Once the primary mechanism exists, the next slice should allow adoption from another shell:

```bash
whisper collab attach codex --tty /dev/ttys012
```

This is the same architecture with a different tty target source. It is useful, but it is not required for the first delivery.

## Command Surface

### `whisper collab attach <codex|claude> --adopt-current-tty`

Responsibilities:

- require an active collab in the current workspace
- resolve the current tty from the shell that invoked the command
- validate that the tty is suitable for adoption
- issue the binding or replacement handshake for the requested role
- start the background adoption agent for that tty
- return quickly so the user can `fg` the suspended provider process

### `whisper collab attach <codex|claude> --tty <path>`

Responsibilities:

- validate the explicit tty path
- adopt that exact tty as the live session target

This is the natural extension of the same mechanism and should be designed now, even if implementation ships later.

### `whisper collab rebind <codex|claude>`

Rebind should reuse the same target selectors:

- `--adopt-current-tty`
- `--tty <path>`
- `--replace`

Replacement remains explicit. The old binding must not lose authority until the new adopted session is confirmed healthy enough to take over.

### `whisper collab reconnect <codex|claude>`

Reconnect should also reuse the same target selectors:

- `--adopt-current-tty`
- `--tty <path>`

Recovery should not invent a different transport. Recovery reconnect should be “adopt this live terminal again,” not “paste a new snippet into a provider prompt.”

## Runtime Model

Phase 7D needs a new adopted-session runtime model:

- the provider already owns the terminal surface
- `whisper` adopts that terminal from the outside
- a background adoption agent attaches to the tty device path
- the provider process remains the visible interactive program after `fg`

This differs from the current foreground `attach-session` model, where the `ai-whisper` process itself takes over the terminal and becomes the visible live-session surface.

Recommended internal structure:

- add a new binding source such as `adopted`
- add tty metadata to the local collab state and relevant broker-visible summaries
- add a background attach/adoption daemon for tty-backed sessions
- add an adopted interactive-session controller that reads from and writes to the tty device path without owning the shell prompt as a foreground process
- keep launched-session runtime and current shell-owned attach-session runtime intact during transition

## Relay Transport Limitation

Adopted sessions cannot intercept inline `@@` relay directives from the terminal.

In the launched/attached flow, the `ai-whisper` process owns the terminal's read side and can intercept keystrokes before they reach the provider. In the adopted flow, the provider process resumes as the foreground process after `fg` and owns the terminal's read side directly. The background adoption daemon runs detached with no stdin. On macOS, two processes cannot reliably share a tty's read side — input is routed exclusively to the foreground process group.

This is a fundamental architectural constraint of the adopted-session model, not an implementation gap.

Relay in adopted sessions works through `whisper collab tell` from a separate terminal. The companion agent loop in the daemon polls the broker for queued work items normally. The write side of the tty remains available to the daemon for rendering local messages (acknowledgements, reply summaries) when work items arrive via the broker.

Phase 7D validates that:

- write-side rendering (acknowledgement and reply-summary messages from broker-queued work) coexists with the resumed foreground provider input after `fg`
- `whisper collab tell` successfully enqueues work items that the adopted daemon processes

## Shell Resume Risk

Phase 7D also must not assume that the suspend-to-shell operator flow automatically preserves resumability with `fg`.

The current foreground `attach-session` model blocks the shell because the attach command itself becomes the long-lived process that owns the terminal. The new adopted-session flow only works if `whisper collab attach <role> --adopt-current-tty` behaves differently:

- the provider is suspended first and remains a stopped shell job
- the attach command runs as a short-lived shell command
- that command starts any required background adoption agent and then exits
- the shell remains usable afterward
- `fg` resumes the original provider process rather than some `whisper` helper

This is a first-class technical risk. If the attach command leaves the shell in the wrong process-group state, takes over the terminal, leaves raw-mode changes behind, or otherwise prevents `fg` from restoring the original provider session cleanly, the workflow fails even if tty adoption itself technically succeeds.

Phase 7D therefore must explicitly validate:

- the shell returns after `whisper collab attach <role> --adopt-current-tty`
- `jobs` still shows the suspended provider as the resumable foreground candidate
- `fg` resumes the original provider process successfully
- the resumed provider remains usable after the attach command exits

## macOS And iTerm Assumptions

Phase 7D is intentionally macOS-first and optimized for iTerm-backed personal shells.

That means it is acceptable in the first version to assume:

- local tty device paths behave like normal Darwin tty devices
- the user has permission to interact with the local tty they are adopting
- the attach flow is run from the same user account that owns the provider session

This phase should not over-generalize beyond the workflow it is actually solving.

## Safety And Failure Handling

Attach must remain explicit and reversible.

Safety rules:

- no auto-discovery of terminals
- no silent rebinding
- one authoritative collab-role binding per target tty
- one target tty cannot silently serve multiple roles or multiple collabs
- `--adopt-current-tty` must fail unless invoked from a real tty-backed shell
- `--adopt-current-tty` and `--tty` are mutually exclusive

Failure handling:

- if adoption setup fails, the shell must remain usable and `fg` must still resume the suspended provider
- if the adoption agent later loses access to the tty, the role becomes degraded
- if the provider process exits, the role becomes degraded
- broker work must not continue blindly against an unhealthy adopted session
- recovery should remember adopted bindings pessimistically and require reconnect or re-adopt rather than pretending the role is fully healthy

## Provider Validation

Phase 7D should avoid pretending it can perfectly identify the foreground provider process on day one.

The first version should validate narrowly:

- the tty exists
- it is local
- it is accessible to the current user
- it is not already bound incompatibly
- the requested role is explicit

Best-effort provider-family checks are acceptable, but they are not required to block first delivery. The core correctness rule is explicit operator intent, not magical provider inference.

## Status And Inspect Expectations

Operator tooling should surface adopted sessions clearly enough to debug them.

`whisper collab status` should remain compact, but should include:

- binding state
- runtime health
- binding source when relevant

`whisper collab inspect` should show richer details for adopted roles, including:

- tty path
- binding source `adopted`
- degraded or recovery-needed state when the adoption agent or provider session is unavailable

## Provider-Skill Layer

A provider-native command such as:

```text
/whisper-attach <collab-id>
```

may be a useful ergonomic layer later, but it must not be the core Phase 7D transport.

Reasons:

- it is provider-specific
- it depends on the provider exposing a real local command or skill hook
- it is easier to mis-handle as plain prompt text

If added later, it should simply trigger the same underlying adopted-terminal attach mechanism. It should not create a second binding protocol.

## Testing Strategy

Phase 7D should be verified with:

- CLI tests for `attach --adopt-current-tty` argument handling and state transitions
- runtime tests for adopted-session health and degradation behavior
- recovery tests proving adopted bindings reconnect through the same target model
- local manual smoke testing on macOS/iTerm for suspend, attach, `fg`, relay, degradation, and reconnect
- explicit validation that relay via `whisper collab tell` reaches the adopted daemon and renders output on the adopted tty
- explicit validation that the shell remains usable after attach and that `fg` resumes the original provider process cleanly

The first implementation should prefer strong targeted tests around explicit state transitions and failure handling over broad environment simulation claims that are hard to trust.

## Completion Criteria

Phase 7D is complete when:

- a user can suspend an already-running Codex or Claude session in iTerm
- run `whisper collab attach <role> --adopt-current-tty`
- return to a usable shell prompt after the attach command completes
- resume that exact provider session with `fg`
- use it as the active bound live session afterward
- relay via `whisper collab tell` from a separate terminal reaches the adopted daemon and produces visible acknowledgement/reply output on the adopted tty
- observe clear degraded state and recovery behavior if the adopted session disappears

At that point, the original personal iTerm workflow is supported without requiring `tmux` or relaunching providers under `whisper`.
