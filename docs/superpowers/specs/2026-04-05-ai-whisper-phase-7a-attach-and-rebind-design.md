# ai-whisper Phase 7A Attach And Rebind Existing Sessions Design

**Date:** 2026-04-05

## Purpose

Split the previously broad Phase 7 bucket into smaller, coherent sub-phases and define the first one clearly.

Phase 7A focuses only on attaching and rebinding existing Codex and Claude sessions to an already-created collab. It is the phase that makes `ai-whisper` fit real terminal workflows where the user starts provider sessions independently in tools such as iTerm2, custom shells, or personal tmux layouts and then wants the bridge to join that setup.

Recovery after loss and broader operator tooling are separate problems and should move to later sub-phases.

## Roadmap Refinement

The roadmap should now be read as:

- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7A: attach and rebind existing sessions
- Phase 7B: recovery after broker, session, or process loss
- Phase 7C: broader operator inspection and admin tooling

This preserves the earlier high-level Phase 7 intent while avoiding one oversized phase with weak boundaries.

## Phase 7A Goal

Phase 7A is successful when a user can:

1. create a collab without launching provider sessions
2. start Codex and Claude independently in their own preferred terminal environment
3. bind each existing provider terminal into the collab through an in-terminal self-attach step
4. explicitly replace an existing binding when needed
5. use the attached sessions with the same relay and broker workflow already established in Phase 6

The goal is not “discover arbitrary sessions automatically.” The goal is to make the bridge usable with existing user-owned sessions.

## In Scope

Phase 7A includes:

- `whisper collab start --no-launch` for creating a collab without launching Codex or Claude
- attach flows for existing Codex and Claude sessions into an already-existing collab
- explicit rebind or replace flows for one role at a time
- in-session self-attach as the primary binding model
- provider-friendly command-snippet attach UX as the primary bootstrap path
- short-lived single-use attach claims under the hood
- minimal status visibility needed to understand whether each role is unbound, bound, or awaiting attach completion
- clear rejection behavior for stale, expired, or replaced sessions

## Out Of Scope

Phase 7A does not include:

- creating a collab through attach
- automatic tmux, PID, or terminal discovery as the primary workflow
- attaching to or recovering a provider's internal conversation state
- recovery after broker restart, tmux loss, or provider crash
- replay or session resurrection UX
- rich inspection of threads, replies, artifacts, or event history
- clipboard helpers, interactive pickers, or other attach UX sugar
- generalized external-provider support beyond the built-in Codex and Claude providers

Those belong to Phase 7B, Phase 7C, or later.

## Design Overview

Phase 7A should use a split model:

- CLI-owned collab creation and attach-claim issuance
- provider-specific in-terminal bootstrap snippets
- broker-owned claim validation and binding acceptance
- shared session-binding rules for attach and rebind
- minimal lifecycle visibility in existing status surfaces

The architectural rule is:

- collab creation still begins at `whisper collab start`
- session binding may now happen later and independently
- attach is explicit and user-directed, not guessed from local process state

This keeps the collaboration model stable while making session ownership more flexible.

## Why Attach Is Its Own Sub-Phase

Attach and rebind establish the meaning of “this collab is bound to this live session.” Recovery and operator tooling both depend on that definition.

Without a clear attach model:

- recovery cannot say what it is restoring
- status tooling cannot say what is currently authoritative
- replacement flows become ambiguous and unsafe

Phase 7A should therefore establish the authoritative binding protocol first.

## Workflow Model

### Collab Creation

`whisper collab start` remains the only collab-creation entrypoint.

Phase 7A adds:

```bash
whisper collab start --no-launch
```

Responsibilities:

- create the collab
- start the broker and supporting local runtime as usual
- record the collab as the active local collab
- leave Codex and Claude unbound until explicit attach happens

This avoids introducing a second top-level “door” for collab creation while still supporting independently started sessions.

### Primary Attach Flow

The primary Phase 7A attach flow is:

1. user runs `whisper collab start --no-launch`
2. user starts Codex or Claude independently
3. user runs a small provider-friendly attach command snippet from that provider terminal
4. the snippet launches the local attach bridge and performs a local attach handshake back into `ai-whisper`
5. the broker accepts the binding for the requested collab role
6. the provider terminal now hosts the attached bridge process for that role

The binding must be initiated from the provider terminal itself, not inferred from an external pane or PID scan.

### Rebind Flow

Rebinding is the same basic handshake, but it replaces an existing role binding explicitly.

Rebind is required when:

- the current bound session is no longer the desired session for that role
- the original session still exists but should no longer receive work
- the user wants to move Codex or Claude participation to a different independently started session

## Command Surface

Phase 7A should add or refine the following commands.

### `whisper collab start --no-launch`

Responsibilities:

- create the collab without launching provider sessions
- make the collab active for subsequent attach commands
- present the operator with the next-step attach instructions for each role

### `whisper collab attach <codex|claude>`

Responsibilities:

- resolve the active local collab created by `whisper collab start`
- verify the requested role is currently unbound
- mint a short-lived attach claim for that role and collab
- print the provider-specific command snippet that should be run from the live provider terminal

Default behavior:

- fail if that role is already bound
- do not silently replace existing bindings

### `whisper collab rebind <codex|claude>`

Responsibilities:

- show the currently bound session for that role
- require explicit operator intent before replacement
- mint a replacement attach claim only after replacement is confirmed
- replace the old binding only when the new session successfully completes the attach handshake

TTY behavior:

- when run interactively, prompt before replacement

Non-interactive behavior:

- do not prompt
- require an explicit replacement flag such as `--replace`

Phase 7A may also allow `whisper collab attach <role> --replace`, but `rebind` should remain the clearer primary UX.

### `whisper collab status`

Phase 7A should extend status only enough to make attach flows understandable.

It should show, per role:

- unbound
- bound
- pending attach claim
- minimal binding identity such as session ID and provider family

This is not Phase 7C inspection tooling. It is just enough state to operate Phase 7A safely.

## Attach Bootstrap Model

### Primary UX: In-Terminal Command Snippet

The primary attach UX should be a command snippet that the user runs from the live provider terminal.

The snippet should:

- be provider-friendly rather than one generic string pasted blindly into every host
- launch the local attach helper or bridge path from that terminal
- carry a short-lived attach claim
- provide enough local context to bind the requested collab role from that terminal

The snippet should be the user-facing proof that “this exact provider terminal is the one being used to host the attached bridge.”

Phase 7A does not require deep provider-native attachment. It does not inject into, recover, or assume ownership of the provider's existing conversation state. It only establishes the broker bridge from a user-owned provider terminal.

### Secondary Fallback: Pasteable Token

If a built-in provider cannot support the command-snippet path cleanly, Phase 7A may use a token-style fallback for that provider only.

That fallback is acceptable as an exception, not as the primary shared design.

The architecture and CLI wording should still treat command-snippet attach as the intended path.

## Attach Claim Model

Phase 7A should introduce a short-lived, single-use attach claim.

Conceptual claim fields:

- `claim_id`
- `collab_id`
- `agent_type`
- `mode` such as `attach` or `rebind`
- `created_at`
- `expires_at`
- `secret` or equivalent proof material

Claim rules:

- claims are tied to exactly one collab and one role
- claims expire quickly
- claims are consumed once
- expired or already-consumed claims are rejected cleanly
- rebind claims do not deactivate the old binding until the new session binds successfully

This keeps attach explicit without making collab state depend on fragile ambient context.

## Session Binding Rules

### Attach

Attach succeeds only when:

- the collab already exists
- the requested role is currently unbound
- the attach claim is valid and unexpired
- the attach helper is launched from the intended provider terminal and passes provider-specific bootstrap validation

On success:

- the session becomes the authoritative bound session for that role
- later relay and broker delivery use that session exactly as if it had been launched by `whisper`

### Rebind

Rebind succeeds only when:

- the collab already exists
- a replacement was explicitly confirmed
- the new attach claim is valid and unexpired
- the new session completes attach successfully

On success:

- the new session becomes authoritative for that role
- the old session is no longer trusted as the bound receiver for that collab role

The old binding should not be removed merely because replacement was requested. It should be replaced only after the new attach completes.

### Stale Session Behavior

After a rebind, an old still-running session may still exist physically.

Phase 7A should treat it as stale rather than authoritative.

That means:

- it must not receive new broker work for the role it used to own
- any relay or control attempt from that stale session should be rejected locally or by the broker with a short message indicating that the session is no longer the active binding

This prevents split-brain behavior without requiring full recovery logic.

## Provider Responsibilities

Each built-in provider should support an attach bootstrap path from an already-running provider terminal.

That bootstrap path must be able to:

- be launched from the provider terminal the user wants to bind
- invoke the local attach helper or equivalent callback into `ai-whisper`
- hand off enough metadata to create the provider-side bridge controller for that terminal

The shared system should not assume that every provider exposes the same exact in-session command mechanism. It should assume only that each built-in provider can supply a provider-specific attach snippet and a provider-specific way to complete the attach handshake.

For Phase 7A, "provider-specific attach validation" should be read narrowly: validating the claim, target role, and bridge bootstrap path. Rich validation of an existing provider conversation or editor/TUI state is later provider-specific work, not part of this phase.

## Minimal Status Model

Phase 7A needs a slightly richer session-state vocabulary than the current launched-only model.

At the conceptual level, each collab role should be understandable as one of:

- `unbound`
- `pending_attach`
- `bound`

Minimal operator-facing details should include:

- session ID
- provider family
- whether the session was `launched` or `attached`
- claim expiry when a pending attach exists

This remains intentionally small. Detailed inspection belongs later.

## Error Handling

Phase 7A should fail clearly and locally for:

- no active collab exists
- attach attempted against a role that is already bound
- rebind requested without explicit replacement confirmation
- claim expired
- claim already consumed
- provider attach bootstrap failed
- session identified itself as the wrong provider role
- stale replaced session attempts to continue acting as the bound role

Error messages should stay action-oriented and explicit about the next step.

Examples:

- `[ai-whisper] Codex is already bound. Use rebind to replace it.`
- `[ai-whisper] Attach claim expired. Run whisper collab attach codex again.`
- `[ai-whisper] This session is no longer the active codex binding for the collab.`

## Testing Expectations

Phase 7A should add tests that prove:

1. `whisper collab start --no-launch` creates a collab without launching provider sessions
2. status shows unbound roles after `--no-launch`
3. `attach` issues a valid pending attach claim for an unbound role
4. a successful in-session attach handshake binds the correct role to the collab
5. relay and directed work operate normally after attaching an independently started session
6. plain `attach` fails when the role is already bound
7. `rebind` prompts in interactive terminal mode
8. non-interactive rebind requires an explicit replacement flag
9. the old session remains authoritative until the new rebind completes successfully
10. after a successful rebind, the old session is rejected as stale
11. expired or already-consumed claims are rejected cleanly
12. provider-specific fallback token flow is tested only where command-snippet attach is not practical

Phase 7A should not add recovery or rich inspection tests. Those belong later.

## Phase Boundary

Phase 7A is complete when `ai-whisper` can join an already-running user-owned Codex or Claude session into an existing collab without requiring `whisper` to have launched that session originally.

Phase 7B should then take on:

- broker restart recovery
- tmux or terminal loss recovery
- provider or companion rejoin after process loss
- replay and repair semantics for damaged collab state

Phase 7C should then take on:

- richer status
- session and thread inspection
- recent failure visibility
- explicit admin and repair tooling
