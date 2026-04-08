# ai-whisper Phase 7E Terminal-First Mounted Sessions Design

**Date:** 2026-04-06

## Reconciliation Update (2026-04-08)

The mounted relay execution assumptions in this document have been corrected by a follow-up spec:

- `docs/superpowers/specs/2026-04-08-ai-whisper-turn-owned-mounted-relay-handoff-design.md`

Reason for the correction:

- the current mounted relay implementation kept the visible sessions as user-facing shells while hidden non-interactive provider invocations performed relay work
- that broke the intended Reviewer/Implementer baton-pass workflow because the visible sessions were not the real execution surfaces

This Phase 7E design remains valid for the terminal-first mounted-session lifecycle, terminal ownership model, and mounted binding semantics.

But the relay behavior described here should now be read together with the follow-up turn-owned handoff spec, which supersedes the earlier hidden-executor relay assumptions for mounted sessions.

## Purpose

Phase 7D made it possible to bind already-running Codex and Claude sessions from normal macOS/iTerm shells. That solved the shell-resume and recovery side of the personal workflow, but it did not solve the original inline relay requirement.

The blocker is architectural: once a provider process resumes as the foreground owner of a tty, `ai-whisper` can no longer transparently intercept terminal input from that same tty. The adopted-session daemon can still write status output to the terminal, but it cannot reliably read `@@...` relay directives from the live provider prompt.

Phase 7E introduces a new path that keeps the iTerm-native terminal experience while restoring inline relay support: `ai-whisper` must take ownership of the terminal first, then launch the provider inside that managed terminal surface.

## Roadmap Refinement

The roadmap should now be read as:

- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7A: shell-owned attach-session bootstrap for manual attach and reconnect
- Phase 7B: broker restart recovery
- Phase 7C1: active-thread monitoring and operator inspection
- Phase 7D: adopt already-running provider sessions on macOS/iTerm
- Phase 7E: terminal-first mounted sessions for inline relay in normal iTerm tabs
- Later follow-up: broader portability, richer diagnostics, and deeper terminal ergonomics

Phase 7D remains valid as the late-adoption path for preserving an already-running provider session. Phase 7E adds a separate, terminal-first path for users who need inline `@@` relay support.

## Phase 7E Goal

Phase 7E is successful when a user can:

1. start a collab with `whisper collab start --no-launch`
2. open a normal iTerm tab for a specific role
3. run `whisper collab mount <role>` in that tab before starting the provider
4. have `ai-whisper` claim the current terminal as the live session surface for that role
5. have `ai-whisper` launch the correct provider automatically inside that mounted terminal
6. use that provider in the same iTerm tab with inline `@@codex ...` / `@@claude ...` relay support

The goal is to preserve the normal iTerm-tab experience, not the exact shell job-control behavior of a previously running provider process.

## In Scope

Phase 7E includes:

- a new terminal-first command: `whisper collab mount <codex|claude>`
- automatic provider launch immediately after the terminal is mounted
- a new binding source for mounted sessions
- inline `@@...` relay interception in mounted sessions
- mounted-session visibility in status and inspect output
- reconnect behavior for mounted sessions after recovery
- clear separation between mounted sessions and Phase 7D late-adopted sessions

## Out Of Scope

Phase 7E does not include:

- retrofitting inline `@@` support onto Phase 7D adopted sessions
- taking over an already-running foreground provider process and proxying it in place
- requiring `tmux` as the primary terminal runtime
- automatic provider discovery in arbitrary existing shells
- provider-native slash commands as the primary relay transport
- cross-platform terminal portability in the first slice

## Product Model

Phase 7E introduces a new session mode with a different contract from Phase 7D.

### Phase 7D: Late Adoption

- user starts provider first
- user later binds the session with `attach --adopt-current-tty`
- original provider process remains the foreground owner after `fg`
- inline `@@` relay is not available

### Phase 7E: Terminal-First Mount

- user starts `whisper collab mount <role>` first
- `ai-whisper` becomes the foreground owner of the current terminal session
- `ai-whisper` launches the expected provider behind its own managed runtime
- inline `@@` relay is available because `ai-whisper` owns terminal input from the start

These two paths serve different needs and should remain explicitly distinct in operator documentation.

## Command Surface

### `whisper collab mount <codex|claude>`

Responsibilities:

- require an active collab in the current workspace
- require a real tty-backed shell
- claim the current terminal as the managed live-session surface for the requested role
- launch the expected provider automatically for that role
- run as the long-lived foreground terminal owner for that mounted session
- intercept inline `@@...` directives before forwarding normal input to the provider

The command should not return quickly to the shell prompt. It is a foreground terminal session runtime, not a short-lived setup command.

### Relationship To Existing Commands

`attach --adopt-current-tty` remains supported as the late-adoption path from Phase 7D.

`mount` is not an alias for `attach`. It has different semantics:

- `attach` binds an already-running provider session
- `mount` claims a terminal first and launches the provider inside it

The operator must not have to infer this distinction from flags alone. The separate verb is required.

## Runtime Model

Phase 7E should use a terminal-first managed runtime:

- `whisper collab mount <role>` starts in the target iTerm tab
- `ai-whisper` owns the user-facing terminal input and output for that tab
- `ai-whisper` launches the expected provider as a child process behind a managed PTY
- provider output is streamed back through the mounted terminal
- normal user input is forwarded to the provider
- inline `@@...` relay directives are intercepted locally and routed through the broker

This is not a `tmux` requirement. The user-facing surface remains the original iTerm tab. The managed boundary is implemented by `ai-whisper`, not by forcing the user into a different terminal product model.

## Provider Launch Contract

Mounted sessions must launch the correct provider automatically.

For example:

- `whisper collab mount codex` launches the configured Codex provider runtime
- `whisper collab mount claude` launches the configured Claude provider runtime

This is required for two reasons:

- it avoids ambiguous "mount first, then maybe launch something" behavior
- it prevents the user from accidentally launching the wrong provider inside the mounted terminal

Mounted sessions should fail fast if the configured provider executable cannot be started.

## Job-Control Tradeoff

Phase 7E intentionally trades away one part of the Phase 7D experience.

Mounted sessions do not preserve the "suspend provider to shell, run attach, then `fg` the original provider job" workflow. In a mounted session, `ai-whisper` is the foreground session owner. The mounted terminal behaves like a managed live-session surface rather than an ordinary shell job that can later be reclaimed with `fg`.

This tradeoff is acceptable because it restores the inline relay behavior that motivated the original personal workflow.

Documentation must state this clearly:

- choose `attach --adopt-current-tty` if preserving an existing provider process matters most
- choose `mount` if inline `@@` relay in the terminal matters most

## Binding Source And State

Phase 7E should add a distinct binding source such as `mounted`.

Operator tooling must distinguish:

- `launched`
- `attached`
- `adopted`
- `mounted`

This matters because mounted sessions are neither:

- broker-launched helper terminals from the earlier launch path
- nor late-adopted existing provider sessions from Phase 7D

The state model should make mounted sessions first-class so reconnect, degradation, and operator inspection do not need to infer behavior from partial metadata.

## Status And Inspect Expectations

`whisper collab status` should remain compact, but clearly show mounted roles:

- binding state
- runtime health
- binding source `mounted`

`whisper collab inspect` should show richer details for mounted roles, including:

- binding source `mounted`
- the current tty path
- provider process identity or pid when available
- degraded or recovery-needed state if the mounted runtime or child provider exits

## Relay Behavior

Mounted sessions are the new inline-relay path.

Phase 7E requires:

- inline `@@codex ...` and `@@claude ...` relay parsing in mounted terminals
- relay preview rendering while the directive is being typed
- relay acknowledgement output after the broker work item is enqueued
- reply-summary rendering when the remote agent replies
- normal non-relay input continuing to reach the mounted provider unchanged

This should reuse the existing live-session relay behavior where possible rather than inventing a second relay UX.

## Recovery And Reconnect

Mounted sessions should reconnect through the same terminal-first model.

The important rule is:

- a remembered `mounted` binding should not reconnect through snippet-shell attach
- a remembered `mounted` binding should not reconnect through Phase 7D late-adoption

Recovery reconnect for mounted sessions should re-enter the mounted runtime from the operator's current terminal and relaunch the correct provider for that role inside the managed session.

Whether that is exposed as:

- `whisper collab reconnect <role>` with auto-detected `mounted` behavior

or as:

- `whisper collab mount <role>` when recovery is pending

is an implementation detail. The user-visible rule must remain consistent: mounted sessions reconnect through mounting, not through late attach.

## Safety And Failure Handling

Safety rules:

- `mount` must fail unless invoked from a real tty-backed shell
- one current terminal can host only one mounted collab role at a time
- the command must fail clearly if the requested role is already healthy and bound, unless an explicit replacement path is added later
- provider-launch failure must surface immediately and leave the terminal in a usable state
- if the mounted runtime dies, the role becomes degraded
- if the child provider exits unexpectedly, the role becomes degraded
- broker work must not continue blindly once a mounted session is unhealthy

Mounted sessions should prefer explicit failure over silently falling back to a different binding mode.

## Legacy Phase 7D Position

Phase 7D is still useful and should remain documented, but with a narrower promise:

- `attach --adopt-current-tty` preserves an already-running provider session
- it supports broker-polled work and write-side status rendering
- it does not support inline `@@` relay interception

This limitation must remain explicit in the docs and smoke tests so operators choose the correct mode intentionally.

## Testing Strategy

Phase 7E should be verified with:

- CLI tests for `collab mount <role>` argument handling and role-specific launch behavior
- runtime tests for mounted-session input interception, passthrough, and relay rendering
- integration tests proving provider launch happens automatically in the mounted runtime
- recovery tests proving mounted bindings reconnect through the mounted path rather than snippet-shell or adopted attach
- manual smoke testing on macOS/iTerm for terminal-first mount, provider launch, inline relay, degradation, and reconnect

The first implementation should prioritize correctness of terminal ownership, relay interception, and failure handling over broad portability claims.

## Completion Criteria

Phase 7E is complete when:

- a user can run `whisper collab mount codex` or `whisper collab mount claude` from a normal iTerm shell
- the correct provider launches automatically inside that same terminal
- inline `@@...` relay works in the mounted provider terminal
- status and inspect clearly show the role as `mounted`
- mounted sessions degrade clearly if the provider or mounted runtime exits
- recovery reconnect for mounted sessions reuses the mounted-terminal model instead of falling back to late attach or snippet-shell bootstrap
- Phase 7D late-adoption remains available and clearly documented as the no-inline-relay path

At that point, `ai-whisper` supports both:

- preserving an existing provider session with late adoption
- and using a normal iTerm tab as a terminal-first managed live-session surface with inline relay
