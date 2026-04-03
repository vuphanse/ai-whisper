# ai-whisper Phase 5 MVP Scope Design

## Purpose

Phase 5 delivers the first real usable `ai-whisper` workflow.

This phase is the point where the project stops being a broker, companion, and mock-provider prototype and becomes a real local collaboration tool that can launch a paired Codex and Claude session and route actual work between them.

The scope is intentionally tight. Phase 5 delivers a CLI-first MVP only. In-session relay syntax, manual attach flows, and resilience polish are deferred to Phase 6.

## MVP Definition

Phase 5 is successful if a user can:

1. start a real Codex and Claude collaboration from the CLI
2. send a directed work request to either side through the CLI
3. have the target side produce a real structured reply through the broker
4. inspect the current collaboration state through the CLI
5. stop the collaboration cleanly

This is the first real MVP because it provides an end-to-end usable workflow without requiring mock providers or internal broker-only control calls.

## In Scope

Phase 5 includes the following deliverables:

- real `whisper collab` CLI support in `packages/cli`
- real Codex provider integration in `packages/adapter-codex`
- real Claude provider integration in `packages/adapter-claude`
- broker, companion, and provider wiring needed to support launched live sessions
- paired-session startup and stop behavior
- active-thread-aware `tell` behavior
- explicit artifact seeding for new-thread commands when the requested action requires concrete context

## Out Of Scope

Phase 5 does not include:

- in-session relay syntax such as `@@codex ...` or `@@claude ...`
- manual attach flows for already-running sessions
- reconnect and replay refinement beyond the existing basic architecture
- local buffering and resilience polish beyond the minimal Phase 4 implementation
- advanced thread inspection or operational subcommands
- richer orchestration policies
- automatic context capture from normal live session conversation
- git-diff shorthand or implicit artifact discovery

Those are reserved for Phase 6.

## Command Surface

Phase 5 supports exactly four user-facing lifecycle commands:

### `whisper collab start`

Responsibilities:

- start the broker if needed
- create or select the current collab context
- launch one Codex session and one Claude session
- bind both sessions to the same collab
- attach their companion/provider wiring automatically

Launch behavior:

- prefer `tmux` when available
- allow explicit opt-out
- if `tmux` is unavailable, inform the user that `tmux` is the preferred UX and fall back to two separate terminal processes

Phase 5 assumes sessions are launched through `whisper`. Manual attach is out of scope.

### `whisper collab status`

Responsibilities:

- show the current collab ID
- show workspace root
- show whether Codex is bound
- show whether Claude is bound
- show the current active thread when one exists
- show broker health

This command is the minimal operator visibility surface for the MVP.

### `whisper collab tell <codex|claude> "..."`

Responsibilities:

- send a directed work item to the paired target session
- reuse the active thread when one exists
- create a new thread when no active thread exists
- carry the correct structured requested action and instruction into the broker

The command should support:

- a required target: `codex` or `claude`
- a required natural-language instruction string
- optional `--action <requested_action>`
- repeatable `--artifact <path>`
- optional `--thread-title <title>`

### `whisper collab stop`

Responsibilities:

- stop the local collab lifecycle cleanly
- stop launched sessions when they are owned by the current run
- stop companions for the local run
- stop the broker when appropriate for the launched local workflow

## Thread And Context Rules

Phase 5 keeps the thread model already approved in earlier designs:

- if an active thread exists, `tell` continues it
- if no active thread exists, `tell` creates a new thread

Phase 5 does not attempt to infer arbitrary conversational context from a live session transcript.

Instead:

- active threads provide the default context for follow-up work
- brand-new threads require explicit context when the action semantics need it

## Action And Context Requirements

Phase 5 supports the existing requested-action model.

The CLI may infer a default action conservatively when `--action` is omitted, but `--action` remains available as an explicit override.

The key rule is:

- actions that require a concrete subject must receive enough explicit context
- actions that are self-contained may be instruction-only

Actions that require explicit context on a new thread:

- `review_plan`
- `implement_plan`
- `review_diff`
- `validate_against_plan`

Actions that may be instruction-only:

- `answer_question`
- `request_clarification`

For Phase 5, explicit context on a new thread is provided only through:

- `--artifact <path>` repeatable
- optional `--thread-title <title>`

No git-diff shorthand or implicit artifact capture is included in this phase.

## Provider Scope

Phase 5 provider integrations are intentionally minimal.

Each real provider only needs to support:

- launch or bind as required by `whisper collab start`
- work delivery
- structured reply capture
- heartbeat

Phase 5 does not require:

- dynamic capability renegotiation polish
- reconnect refinement
- local buffering refinement
- rich degraded-mode handling

The goal is a real end-to-end path, not the final resilient production shape.

## Launcher Scope

The launcher in Phase 5 should focus on the paired-session happy path:

- sessions are launched by `whisper collab start`
- both are scoped to one collab
- the collab is the unit of routing

The MVP does not need to solve:

- attaching to arbitrary pre-existing sessions
- rebinding partially launched sessions
- advanced recovery after terminal or process loss

## Testing Expectations

Phase 5 should add tests that prove:

1. CLI lifecycle commands can create and stop a collab
2. a real provider-backed `tell` operation can enqueue, deliver, and reply
3. active thread reuse works
4. new-thread context enforcement works for actions that require artifacts
5. fallback launch behavior works when `tmux` is unavailable

Tests may use controlled provider/session doubles where direct live Codex or Claude integration would be unstable in automated environments, but the code paths should be the real Phase 5 CLI and provider orchestration paths.

## Phase Boundary

Phase 5 is complete when the product is usable through the CLI alone.

Phase 6 then becomes the refinement phase for:

- in-session relay syntax
- attach flows
- resilience improvements
- richer operator commands
- UX polish
- workflow refinement toward the original “dream workflow”
