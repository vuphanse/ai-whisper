# ai-whisper Phase 6 In-Session Relay Workflow Design

**Date:** 2026-04-04

## Purpose

Narrow the originally broad post-MVP "Phase 6" bucket into one coherent next step: move the primary collaboration loop from the CLI into the live Codex and Claude sessions through explicit in-session relay.

Phase 5 already delivered the CLI-first MVP. Phase 6 should not mix relay ergonomics with attach, recovery, and operator-heavy lifecycle work. Those are a separate class of problem and should move to Phase 7.

## Roadmap Correction

The roadmap should now be read as:

- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7: attach, recovery, and operator tooling

This corrects the earlier roadmap wording that blurred the shipped Phase 5 CLI scope together with future relay and recovery behavior.

## Phase 6 Goal

Phase 6 is successful when a user can start a collab through the CLI and then perform normal cross-agent delegation directly inside the live sessions using explicit relay directives.

The phase should make the common workflow feel faster and more natural without broadening into attachment, rebinding, or recovery complexity.

## In Scope

Phase 6 includes:

- explicit in-session relay directives such as `@@codex ...` and `@@claude ...`
- relay directive interception only inside sessions attached to an active collab
- reuse of the existing collab, thread, work-item, and reply model
- active-thread continuation by default
- forced new-thread relay through a minimal inline override
- short local acknowledgement in the origin session
- concise paired reply summaries injected back into the origin session
- local validation and clear error messages for unsupported relay usage

## Out Of Scope

Phase 6 does not include:

- attaching to already-running sessions
- rebinding a lost session
- replay or recovery UX
- richer history, inspection, or operational admin commands
- broad UX polish unrelated to relay itself
- large inline relay grammars with thread IDs, artifact arguments, or operator flags

Those belong to Phase 7 or later.

## Design Overview

Phase 6 should use a split design:

- provider-specific relay interception
- shared relay workflow logic
- coordinator-owned broker artifact lifecycle
- provider-specific origin-session notification
- provider-specific one-shot broker execution behind the live relay UX

The shared broker and thread model remains the source of truth for routing and lifecycle. The providers own only the host-specific seams: detecting relay directives in live sessions and injecting acknowledgement or reply-summary text back into those sessions.

This keeps relay policy centralized without pushing Codex/Claude-specific behavior into the broker.

## Architecture

### `RelayInterceptor`

Each built-in provider should add provider-specific logic that can:

- observe live session input or output as needed
- detect explicit relay directives
- consume the directive so it does not remain as ordinary conversation text

This interception should activate only when the session is bound to an active collab.

### `RelayService`

Phase 6 should add a shared relay service that owns:

- directive parsing
- target resolution
- thread selection
- requested-action inference
- explicit-artifact policy enforcement
- broker work-item enqueueing
- acknowledgement text selection
- reply-summary formatting

This service should align with the existing semantics already used by CLI `tell` rather than inventing a second policy surface.

### `BrokerArtifactService`

Phase 6 should add a coordinator-owned broker artifact service for live-session relay delivery.

This service should:

- create one retained artifact directory per broker work item under a machine temp root rather than the user workspace
- write an authoritative `request.json` for the work item
- maintain `status.json` with lifecycle state, attempt history, and short readable debugging metadata
- apply best-effort cleanup with short retention windows rather than deleting artifacts immediately

This keeps artifact lifecycle and cleanup in the collaboration coordinator path instead of pushing it into provider adapters.

### File-Backed Broker Delivery

The supported Phase 6 broker-delivery path for relay work should be file-backed.

That means:

- the relay service still enqueues broker work through the shared collab and thread model
- the coordinator creates a retained request artifact after enqueueing, once the real `workItemId` exists
- the broker execution path reads the authoritative `request.json` rather than reconstructing structured work from inline prompt text
- the request file is the authoritative source of truth and must override conflicting ambient session context
- the broker reply still returns through the existing structured provider reply contract

Phase 6 should not treat long inline broker prompt injection into an attached TUI as a supported delivery mechanism. Debug evidence showed that PTY-driven live-session prompt injection was not reliable enough across Codex and Claude, even after file-backed artifacts, temp-root access, submit timing, and timeout tuning were added.

The architectural correction is:

- keep the live session as the user-visible collaboration surface
- keep relay interception and acknowledgement inside the live session
- execute broker work through the provider's non-interactive path against the retained file-backed request artifact
- inject only concise acknowledgement and reply-summary text back into the origin live session

This preserves the Phase 6 user workflow while removing the least reliable part of the earlier design.

### `OriginSessionNotifier`

Each built-in provider should add provider-specific logic that can inject short local messages back into the originating session:

- acknowledgement after accepted relay
- concise success or failure summary after the paired reply arrives
- local validation errors when relay is rejected before enqueue

## Relay Syntax

Phase 6 should support only two relay forms:

```text
@@codex <instruction>
@@claude <instruction>
```

And one minimal override:

```text
@@codex[new] <instruction>
@@claude[new] <instruction>
```

The design should defer more complex inline controls such as:

- explicit thread ID targeting
- inline artifact paths
- inline requested-action flags
- broader mini-language parsing

This keeps Phase 6 focused on the common case.

## Thread And Context Rules

Default routing should remain simple:

- if an active thread exists, relay continues it
- if no active thread exists, relay creates a new thread
- `[new]` forces a new thread even when one is active

Requested action should be inferred using the same conservative policy already used by the CLI `tell` path.

Phase 6 should not scrape arbitrary recent transcript context from the live session. The same core rule from Phase 5 still applies:

- actions that require a concrete subject need explicit context on a new thread
- actions that are self-contained may be instruction-only

When a relay would create a new thread for an action that requires explicit artifacts, the relay should be rejected locally with a short message telling the user to seed the thread through `whisper collab tell --artifact ...` first.

That preserves the CLI as the explicit-context escape hatch instead of bloating the Phase 6 relay grammar.

## Acknowledgement Behavior

Relay acknowledgement should be short, local, and visible.

Examples:

- `[ai-whisper] Relayed to codex on active thread.`
- `[ai-whisper] Started new thread and relayed to claude.`

The raw relay directive should not remain in the host session as ordinary conversation text after it is successfully intercepted.

## Reply Presentation

When the paired provider reply returns through the broker, the origin session should receive one concise inline summary.

Examples:

- `[ai-whisper][codex] success: plan looks coherent; main gap is deployment rollback.`
- `[ai-whisper][claude] failure: missing plan artifact for implementation review.`

Phase 6 should optimize for conversational flow, not exhaustive inline inspection. Richer inspection remains a CLI and later-phase concern.

## Error Handling

Phase 6 should fail locally and clearly for:

- invalid relay syntax
- unsupported advanced syntax
- missing required explicit context on a new thread
- broker or provider failures that prevent successful completion

Error messages should stay concise and action-oriented. When the correct fix is to use the CLI seeding path, the message should say so directly.

## Testing Expectations

Phase 6 should add tests that prove:

1. relay directives are intercepted only inside attached active collab sessions
2. normal non-relay conversation is not intercepted
3. target resolution works for both Codex and Claude relay
4. active-thread relay continues the current thread
5. `[new]` creates a fresh thread
6. requested-action inference stays aligned with the CLI `tell` policy
7. new-thread actions that require explicit artifacts are rejected locally
8. acknowledgement messages appear in the origin session
9. concise reply summaries appear in the origin session after paired replies
10. file-backed broker delivery creates authoritative retained request artifacts outside the user workspace
11. non-interactive provider execution consumes those retained artifacts as the source of truth for broker work
12. live-session relay remains responsible for interception, acknowledgement, and reply-summary injection without depending on PTY-driven broker prompt execution

Phase 6 should not add attach, rebinding, or recovery tests. Those belong to Phase 7.

## Phase Boundary

Phase 6 is complete when in-session relay becomes the default day-to-day collaboration loop for already-launched paired sessions.

Phase 7 then becomes responsible for:

- attach and rebind workflows
- resilience and recovery behavior
- broader operator and inspection tooling
- workflow refinement beyond the minimal relay-supporting polish in this phase
