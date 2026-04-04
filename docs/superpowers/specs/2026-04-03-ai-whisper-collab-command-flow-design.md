# ai-whisper `whisper collab` Command Flow Design

**Date:** 2026-04-03

## Goal

Define the user-facing command flow and launcher behavior for `ai-whisper` v1, including:

- canonical CLI organization
- collab startup behavior
- terminal orchestration
- in-session relay syntax
- active thread behavior
- local acknowledgement behavior
- reply presentation
- status and inspection commands

This document defines how the user experiences live paired collaboration once the broker, companion, and schema layers are in place.

## Design Inputs

This design builds on the approved system, broker, schema, and companion decisions:

- `whisper collab` is the user-facing collaboration concept
- the collaboration scope binds exactly one Codex session and one Claude session in v1
- `whisper collab start` is the primary launch path
- `tmux` is the preferred terminal orchestrator when available, with opt-out
- if `tmux` is unavailable, the user should be informed it provides the smoother UX and may fall back to two separate terminal processes
- in-session cross-agent delegation should use explicit relay markers rather than fully implicit intent detection
- relay marker syntax should use `@@codex ...` and `@@claude ...`
- relay should use balanced context capture from the current active thread
- relay should continue the current active thread when one exists, otherwise create a new thread
- inline thread override syntax should be supported
- host sessions should see short local acknowledgements, not raw relay directives echoed back into the normal conversation stream
- paired replies should appear as concise inline summaries by default, with full inspection available on demand
- `whisper collab status` should support a concise default view and a more operationally detailed mode

## CLI Organization

`ai-whisper` v1 should use a mixed alias model.

### Canonical namespace

- `whisper collab ...`

### Convenience aliases

Allowed for high-frequency commands such as:

- `whisper tell ...`
- `whisper thread ...`

### Design rule

The canonical documentation and internal command mapping should treat `whisper collab ...` as primary, even if aliases exist for convenience.

### Rationale

This preserves one coherent mental model while still keeping common commands fast to type.

## Startup Flow

The primary entry point is:

```bash
whisper collab start
```

### Expected startup sequence

1. Resolve the workspace root.
2. Start the broker if it is not already healthy for that workspace context.
3. Create or select a collaboration scope with a `collab_id`.
4. Launch one Codex session and one Claude session.
5. Start or attach one companion per session.
6. Bind both sessions to the same collaboration scope.
7. Return control to the user with paired live sessions ready.

### Initial thread state

No active thread should exist automatically at startup.

The first relay action creates the first thread unless one already exists from an earlier resumed collaboration state.

### Rationale

This avoids creating meaningless bootstrap threads and keeps shared context aligned to actual collaborative work.

## Terminal Orchestration

Terminal orchestration should prefer `tmux` but not require it unconditionally.

### Preferred behavior

- if `tmux` is available, it is the primary launch path
- `tmux` should be used by default unless the user explicitly opts out

### Fallback behavior

- if `tmux` is unavailable, tell the user that `tmux` provides the smoother UX
- then offer fallback to two separate terminal processes if the user chooses not to use or install `tmux`

### Rationale

The paired-session workflow is easier to manage in one terminal window, but fallback must remain possible on systems without `tmux`.

## In-Session Relay Model

Once a collaboration is active, the normal day-to-day workflow should happen inside the live Codex and Claude sessions.

### Relay syntax

Examples:

```text
@@codex review this plan
@@claude implement phase 1
@@codex validate this diff against the plan
@@claude[new] implement this in a fresh thread
```

### Design rule

The adapter should intercept relay directives only when the session is attached to an active collaboration scope.

### Rationale

This preserves the natural feeling of working inside the session while keeping relay detection explicit and reliable.

## Relay Context Capture

Relay directives should use a balanced context policy.

### Default behavior

- include the current active thread context by default
- do not capture arbitrary unrelated recent conversation outside that thread

### Rationale

This keeps relay packets useful without turning them into uncontrolled transcript scraping.

## Active Thread Behavior

Thread routing should follow the current active thread by default.

### Default routing rule

- if there is an active thread, continue it
- if there is no active thread, create a new thread

### Rationale

This preserves continuity for the common case while still allowing the first relay in a session to bootstrap a meaningful shared task container.

## Inline Thread Override

Phase 6 should support only one minimal inline override even though the default workflow should rarely require it.

### Supported form

```text
@@codex[new] review this independently
```

### Design rule

The `[new]` override is the only supported inline routing control in Phase 6.

Explicit thread targeting and broader inline routing controls should be deferred to a later phase.

### Rationale

This keeps the core workflow simple while preserving one escape hatch for fresh-thread routing when needed.

## New-Thread Context Rule

If a relay creates a new thread for an action that requires explicit artifacts, the live session should reject it locally and direct the user back to the CLI seeding path.

Example:

```bash
whisper collab tell --target codex --action review_plan --artifact docs/plan.md "review this plan"
```

### Design rule

Phase 6 live-session relay should not add inline artifact arguments or broad context-override grammar.

### Rationale

This preserves the CLI as the explicit-context escape hatch and keeps the in-session relay grammar intentionally small.

## Local Acknowledgement Behavior

The raw relay directive should not remain in the host session as ordinary conversation content.

### Expected behavior

The adapter consumes the directive and emits a short local acknowledgement such as:

- `[ai-whisper] Relayed to codex on active thread.`
- `[ai-whisper] Started new thread and relayed to claude.`

### Design rule

Acknowledgement should be short and visible.

It should not become a verbose operational summary by default.

### Rationale

This gives the user immediate confidence that the relay was recognized and routed, without cluttering the live conversation.

## Reply Presentation

When the paired agent replies through the broker, the origin session should receive a concise inline summary by default.

### Default behavior

- show a short inline summary in the origin session
- allow full thread inspection on demand through the CLI or thread inspection commands

### Rationale

This preserves conversational flow and avoids flooding the session with broker metadata or full remote output every time.

## Status and Inspection

`whisper collab status` should support both a concise and an operational view.

### Default view

Should include:

- current collab
- bound sessions
- active thread

### Detailed view

Should include:

- broker health
- session health
- replay state
- buffering state

### Rationale

Most of the time the user wants fast orientation. When debugging or recovering, they need operational detail.

## Role of the CLI After Startup

After collaboration is established, the CLI should remain the tool for:

- startup
- status inspection
- thread inspection
- recovery and admin operations
- shutdown

It should not be required for every cross-agent relay during active collaboration.

## Example Flow

### Startup

```bash
whisper collab start
```

Result:

- paired Codex and Claude sessions launch
- broker is healthy
- companions are attached
- no active thread exists yet

### First relay

In Claude:

```text
@@codex review this architecture plan
```

Result:

- a new thread is created
- a work item is routed to Codex
- Claude sees a short local acknowledgement

### Follow-up relay

Later in Claude:

```text
@@codex validate this diff against the plan
```

Result:

- the active thread is continued
- Codex receives a follow-up work item using active thread context

### Status inspection

```bash
whisper collab status
```

Result:

- concise collaboration and active thread summary

## Constraints and Non-Goals

This design intentionally does not define:

- exact CLI parsing implementation
- exact alias list
- exact `tmux` pane layout
- exact format of inline summary messages
- exact thread inspection subcommand structure

Those belong in later command and implementation planning documents.

## Recommended Next Technical Design

The next technical design should define one of:

- concrete broker API and event payload contracts
- adapter boundary contracts for Codex and Claude host integration
- exact command parsing and session-launcher behavior

At this point, the project is also close to being ready for an implementation plan if you want to stop design expansion and start execution planning.
