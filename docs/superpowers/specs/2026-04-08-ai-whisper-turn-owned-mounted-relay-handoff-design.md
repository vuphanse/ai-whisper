# ai-whisper Turn-Owned Mounted Relay Handoff Design

**Date:** 2026-04-08

## Purpose

This follow-up spec corrects the relay execution model introduced across the earlier in-session relay and mounted-session designs.

The current mounted relay implementation made a critical product mistake: the visible Codex and Claude sessions are not the real relay execution surfaces. Relay work is currently handled by hidden non-interactive provider invocations, which breaks the core workflow requirement that the visible Reviewer and Implementer sessions should share the same topic, repo state, and collaboration context throughout the workflow.

This document defines the corrected product model:

- the visible mounted sessions are the real workflow actors
- relay is a turn-based handoff workflow between those visible sessions
- hidden background provider execution is no longer the desired product model for mounted relay
- safe human-confirmed handoff is the guaranteed behavior for this phase
- full automatic handoff into the visible owner session remains a later upgrade

## Relationship To Earlier Specs

This spec is a follow-up, not a rewrite of the whole system.

It supersedes the relay execution assumptions in:

- `docs/superpowers/specs/2026-04-04-ai-whisper-phase-6-in-session-relay-workflow-design.md`
- `docs/superpowers/specs/2026-04-06-ai-whisper-phase-7e-terminal-first-mounted-sessions-design.md`

Those earlier specs remain useful historical context for:

- mounted-session lifecycle
- relay monitor/operator surfaces
- session binding and recovery concepts
- shared broker state and persistence

But their assumption that mounted relay should execute through hidden non-interactive provider invocations is no longer the intended product truth.

## Workflow Target

The corrected workflow target is a baton-pass loop between two visible sessions.

Example:

1. Reviewer sends work to Implementer.
2. Reviewer blocks and waits.
3. Implementer becomes the turn owner.
4. Implementer decides when to accept or defer the pending handoff.
5. Implementer performs the work in the visible Implementer session.
6. Implementer explicitly hands the turn back to Reviewer.
7. Reviewer becomes the turn owner and repeats the pattern.

The key rule is that the visible sessions, not hidden surrogate processes, are the collaboration participants.

## Core Product Model

### Turn Ownership

Relay workflow should track explicit single-owner turn state:

- `codex`
- `claude`
- `none`

Rules:

- exactly one owner or `none`
- `none` means workflow idle
- when `none`, both providers accept normal user input
- when one provider owns the turn, the other provider is the waiting side

### Handoff Contract

When one provider sends a relay handoff:

- ownership flips immediately to the target role
- the sender blocks immediately and enters waiting state
- the new owner receives a pending handoff in its visible mounted session
- the owner may defer, accept, or decline
- the sender remains blocked until the owner explicitly declines, cancels, or hands the turn back

This is a workflow contract, not just message transport.

### Visible Session Truth

Mounted relay must preserve three kinds of truth equally:

- visible provider conversation truth
- shared repo/artifact truth
- workflow truth such as turn ownership and pending handoffs

The system must not claim that a visible session is performing work while a hidden provider invocation is actually doing it elsewhere.

## In Scope

This follow-up includes:

- explicit turn ownership for mounted relay
- pending handoff lifecycle for mounted sessions
- sender-side waiting/blocking driven by turn state
- explicit waiting-side stdin interception in mounted runtime
- owner-side pending handoff UI in the mounted PTY
- guaranteed safe accept flow using a multiline local composer before injection
- explicit bare decline
- explicit handback back to the waiting side
- assisted handback result capture using the latest assistant turn when possible
- empty multiline handback composer fallback when extraction is low-confidence
- relay monitor updates to reflect turn and handoff lifecycle
- spec-level deprecation of hidden relay execution as the desired mounted relay model

## Out Of Scope

This follow-up does not require:

- full automatic handoff injection with no user confirmation
- reliable provider idle detection
- automatic completion detection from terminal output
- perfect PTY transcript understanding
- provider-native structured APIs for interactive prompt state
- cross-platform terminal guarantees beyond the existing mounted-session scope

Those are later improvements if the guaranteed fallback proves stable.

## Handoff UX

### Sender Side

When the sender issues `@@codex ...` or `@@claude ...`:

- the relay directive is accepted only if the workflow contract allows the handoff
- ownership flips immediately
- the sender PTY blocks immediately
- the sender sees waiting UX tied to the new owner
- sender input remains blocked until the owner resolves the handoff

The blocking mechanism must be implemented explicitly in mounted runtime.

Mounted runtime is the foreground terminal owner for mounted sessions, so it should:

- continue reading stdin normally
- swallow ordinary user keystrokes on the waiting side instead of forwarding them to the provider PTY
- keep only the allowed workflow escape path such as `Ctrl+C`
- redraw waiting UX reactively while the sender is blocked

The design must not rely on passive PTY behavior or assume that a provider shell will block keyboard input on its own.

### Owner Side

The owner receives a pending handoff card in the visible mounted PTY.

The owner may:

- defer
- accept
- decline

Deferring does not release the sender. It only means the owner keeps the turn while postponing execution of the pending handoff task.

### Stale Handoffs

Deferred handoffs may remain pending for a long time, and the sender still waits.

For this phase, the workflow contract should remain strict:

- a stale handoff does not automatically release the sender
- a stale handoff does not automatically return ownership

Instead, the system should surface explicit stale visibility:

- record handoff age
- mark long-pending handoffs as `stale_handoff`
- show stale state clearly in relay monitor, status, and inspect output
- preserve explicit owner action as the only normal way to resolve the handoff

This preserves the baton-pass contract without silently changing workflow state behind the users' backs.

Decline is bare:

- no reason required
- sender is released
- workflow records the decline event

### Guaranteed Accept Flow

The guaranteed behavior for this phase is not blind automatic injection.

Instead:

1. owner chooses accept
2. `ai-whisper` opens a multiline local accept composer
3. the original handoff request is prefilled
4. owner may edit it
5. on submit, that text is injected into the visible owner session

After submit, the provider is doing normal visible-session work.

### Automatic Handoff Upgrade Path

Later, the accept flow may collapse into immediate automatic injection when:

- injection timing is proven reliable
- mounted runtime can avoid corrupting partial local input
- provider/session state constraints are understood well enough

That later behavior is an upgrade path, not a requirement for the guaranteed phase behavior.

## Waiting And Cancellation

### Waiting

The waiting side remains blocked throughout the owner's decision and execution window.

This is intentional:

- it preserves the baton-pass contract
- it prevents both visible sessions from acting as if they own the workflow at once

### Cancellation

Cancellation semantics split into two phases:

- before accept/inject: cancellation is workflow-level and immediate
- after accept/inject: cancellation should use the provider's native interactive cancellation behavior because the task is now normal visible-session work

This is stronger than the old hidden-executor path, where in-flight cancellation was only best-effort after delivery.

## Overlapping Handoffs

For this phase, overlapping unresolved handoffs are not allowed.

Rule:

- only one unresolved handoff may exist at a time for a collab

That means:

- if a handoff is pending, accepted, deferred, or otherwise unresolved, a new relay attempt should be rejected locally
- the rejection should explain that the current handoff must be resolved before another relay can begin

This keeps the single-owner workflow model unambiguous and avoids queue semantics in the first slice.

## Handback And Result Capture

### Explicit Handback

The system should not attempt to infer semantic completion from PTY behavior alone.

Completion is explicit:

- the owner decides when they are ready to hand the turn back
- handback is the authoritative completion signal

### Default Capture Source

Handback result capture should default to:

- latest assistant turn only

This is the best candidate for a concise return payload and avoids dragging in unrelated output from the whole turn.

### Latest Assistant Turn Boundary

For this phase, "latest assistant turn" should be interpreted conservatively.

The mounted runtime should attempt to capture:

- the most recent completed assistant-output block observed after handoff acceptance
- excluding local workflow overlays, ANSI-only redraws, and owner keystrokes

It should not assume perfect provider-native semantic boundaries.

### Low-Confidence Extraction Rule

Extraction should be treated as low-confidence when any of the following is true:

- no completed assistant-output block has been observed since handoff acceptance
- provider output appears to still be streaming or actively in progress
- captured content is empty after stripping ANSI control sequences and whitespace
- captured content is dominated by workflow overlays, tool markup, or terminal noise rather than assistant content
- user input and provider output are interleaved in a way that prevents a clean latest-assistant-turn boundary from being identified

### Low-Confidence Fallback

If `ai-whisper` cannot confidently extract a clean latest assistant turn:

- open a blank multiline handback composer
- allow the user to paste or edit the return payload manually

This is safer than automatically falling back to all output since accept.

### Why Manual Fallback Is Acceptable

Manual fallback is a last resort, not the default path.

The normal path is:

- explicit handback
- assisted capture of the latest assistant turn

The blank composer exists only to preserve correctness when extraction confidence is low.

## Architecture Changes

### Broker Role

The broker remains the workflow/state coordinator.

It should track:

- `turnOwner`
- pending handoff records
- handoff lifecycle events
- sender waiting state
- decline/cancel/handback events
- stale handoff state and age metadata
- unresolved handoff exclusivity

It should not remain the hidden execution engine for mounted relay as the primary product model.

### Mounted Runtime Role

Mounted runtime becomes the main workflow boundary around the visible provider session.

It should own:

- outgoing handoff interception
- sender blocking
- waiting-side stdin swallowing except the workflow escape path
- pending handoff card rendering
- accept composer rendering
- safe request injection after accept submit
- owner-side capture of candidate assistant output for handback
- handback composer rendering

Mounted runtime should also detect owner-session termination during unresolved handoff and surface that failure into workflow state.

### Relay Monitor Role

Relay monitor should evolve from request/response log display into explicit workflow visibility for:

- current turn owner
- waiting role
- pending handoff
- accepted/in-progress state
- stale handoff state
- declines
- handback transitions

The monitor remains an operator surface, but it should reflect the turn model directly.

Monitor refresh should be driven by broker state changes or repeated reads from broker truth, not by local assumptions cached only inside one mounted runtime.

## Legacy Transitional State

The current hidden `handleWork(...)` execution path may still exist in code temporarily while the system transitions.

However, the updated product truth is:

- mounted relay is not considered correct if the visible session is not the real actor

## Disconnect And Failure Handling

If the owner mounted session disconnects or crashes while a handoff is unresolved:

- the handoff must not remain silently pending forever
- the workflow should move to a failed or degraded handoff state
- the blocked sender should be released
- relay monitor, status, and inspect should surface recovery guidance clearly

This should not be modeled as an implicit decline, because the owner did not choose to reject the handoff.

The new spec should treat the hidden executor path as transitional legacy behavior, not as the desired mounted relay architecture.

## Testing Strategy

The follow-up implementation should prove:

1. turn ownership flips immediately on handoff
2. sender input blocks immediately after handoff
3. owner sees a pending handoff card
4. owner can defer without releasing sender
5. owner can decline and release sender
6. accept opens a multiline prefilled composer
7. accept submit injects into the visible owner session
8. explicit handback returns ownership to the waiting side
9. handback capture prefers latest assistant turn only
10. low-confidence extraction falls back to a blank multiline handback composer
11. relay monitor reflects turn owner and handoff lifecycle states

## Test Harness Requirements

The implementation plan should explicitly account for test infrastructure supporting:

- mounted runtime stdin interception on the waiting side
- PTY-like owner-session transcript capture for handback extraction
- transcript fixtures that include ANSI noise, workflow overlays, and interleaved user/provider output
- owner disconnect during unresolved handoff
- local rejection of overlapping unresolved handoffs

These are integration-heavy behaviors and should not be left implicit in the plan.

## Completion Criteria

This follow-up is complete when:

- mounted relay truthfully models a single-owner baton-pass workflow
- the visible mounted sessions are the actual workflow actors
- the guaranteed fallback supports explicit accept and explicit handback without hidden relay execution
- the existing relay monitor and mounted-session surfaces reflect the corrected workflow model clearly
