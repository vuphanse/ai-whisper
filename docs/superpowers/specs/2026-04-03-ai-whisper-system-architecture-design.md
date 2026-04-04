# ai-whisper System Architecture Design

**Date:** 2026-04-03

## Goal

Build a local collaboration bridge that allows Codex and Claude Code to exchange task-scoped context autonomously enough to support this workflow:

- Codex handles research, planning, and review
- Claude handles execution and implementation
- Either agent can cross-check the other's deliverables through a shared task thread

The project goal is intentionally narrow. `ai-whisper` is not a generic multi-agent platform, a session recorder, or a workflow scheduler. It is a local broker for direct, task-oriented collaboration between two agent sessions.

## Background Decisions

The following constraints were established during initial design discussion:

- Transport model: local daemon/API
- User control: explicit forwarding via command, with autonomous follow-up allowed within a task thread
- Command surface: standalone shell CLI
- Agent integration: companion process per active agent session
- Shared context model: structured task threads, not full raw session mirroring
- Artifact scope: file paths, git diffs, and generated docs/plans
- Primary user intent: support plan handoff, implementation handoff, review, and validation between Codex and Claude Code

## Problem Statement

Codex and Claude Code can operate in the same workspace, but they do not natively share a live working context. That creates friction when one agent researches or plans and the other implements, because the second agent must reconstruct context manually. It also weakens cross-review, since review requests often arrive without the exact decisions, artifacts, and success criteria that shaped the work.

`ai-whisper` solves this by creating a shared, local task thread that both agents can read from and write to through stable companion processes. The thread becomes the source of truth for the collaboration, while each agent keeps its own private session context.

## Scope

### In Scope for v1

- Create task threads from a local CLI
- Route messages between Codex and Claude companions through a local broker
- Require a structured handoff packet for forwarded tasks
- Persist task messages, statuses, and artifacts locally
- Support autonomous follow-up messages inside an existing task thread
- Support common workflows such as:
  - "Codex, review this plan"
  - "Claude, implement this plan"
  - "Codex, validate this diff"

### Out of Scope for v1

- Full session transcript syncing
- Broker-owned terminal scraping or PTY injection as the primary transport
- Cloud-hosted relay or multi-machine synchronization
- Arbitrary multi-agent orchestration beyond thread routing
- Rich GUI
- Broad plugin-specific integrations

## System Architecture

`ai-whisper` consists of four primary components.

### 1. `whisper` CLI

The CLI is the explicit user-facing control surface.

Responsibilities:

- Create a new task thread or target an existing one
- Forward a request to a specific agent
- Attach optional artifact references
- Show thread status and recent messages
- Surface escalation states back to the user

Representative commands:

```text
whisper tell codex "review this plan"
whisper tell claude "implement the approved plan"
whisper thread show <thread-id>
whisper thread list
```

The CLI is the boundary for user-approved forwarding. New cross-agent work starts here.

### 2. Local Broker Daemon

The broker daemon is the source of truth for collaboration state.

Responsibilities:

- Accept CLI requests
- Store task threads and messages
- Route messages to the correct agent companion
- Enforce policy for user-triggered forwarding and bounded autonomous follow-up
- Persist artifact metadata
- Track task lifecycle and escalation states

The broker should expose a simple local API over a Unix socket or localhost HTTP interface. The exact transport can be chosen during implementation, but it must remain local-only in v1.

### 3. Agent Companions

Each active Codex or Claude session runs a lightweight companion process.

Responsibilities:

- Register the local agent identity with the broker
- Poll or subscribe for incoming thread events
- Ask the host agent for a structured handoff or reply packet
- Deliver broker work into an attached live session when Phase 6 relay is active
- Return framed live-session replies back to the broker
- Return messages and artifact references back to the broker
- Report whether the agent can continue autonomously or requires user escalation

The broker should never depend on directly controlling an interactive terminal session as its primary mechanism. That boundary still matters in Phase 6.

However, attached live-session companions may use host-side interactive terminal control as a local delivery seam for already-running Codex or Claude sessions. In that mode, the companion remains responsible for the terminal-specific behavior:

- injecting a short provider-specific broker instruction into the attached session
- reading a file-backed structured request from disk
- extracting a framed reply back into the broker reply model

This keeps terminal-specific behavior localized to the host companion/adapter layer instead of turning the broker itself into a terminal controller.

### 4. Shared Task-Thread Store

The shared store persists all collaboration state needed to resume or inspect a thread.

Persisted entities:

- thread metadata
- participants
- messages
- context packets
- artifact references
- lifecycle status
- escalation state

The store is task-scoped. It is not intended to reproduce either agent's full private conversation history.

## Shared Context Model

The shared context unit is a structured task thread. Each forwarded request must carry a context packet that gives the receiving agent enough information to act without needing the sender's full transcript.

Required handoff packet fields:

- `goal`
- `current_state`
- `decisions_made`
- `assumptions`
- `relevant_artifacts`
- `open_questions`
- `requested_action`
- `success_criteria`

Optional fields:

- transcript excerpts when nuance matters
- warnings or constraints
- agent confidence or uncertainty markers

This model keeps context high-signal and task-relevant while still allowing traceability when the receiving agent needs more detail.

## Interaction Flow

### User-triggered forwarding

1. The user runs `whisper tell codex "review this plan"`.
2. The CLI submits the request to the broker.
3. The broker creates or updates a task thread.
4. The broker routes the task to Codex's companion.
5. The companion asks Codex for a response packet.
6. The response is written back to the thread with artifact references.

### Autonomous follow-up inside a thread

1. Claude receives Codex's review result through the same thread.
2. Claude replies with implementation updates or clarification requests.
3. The broker permits follow-up exchanges within the existing thread.
4. If a policy boundary is crossed, the thread enters an escalation state and requires a new user command.

This hybrid model preserves user control over task initiation while reducing friction inside an active collaboration thread.

## Artifact Model

Artifacts supported in v1:

- file paths
- git diffs
- generated plans
- generated design documents

Artifacts are attached by reference and metadata first. The system should avoid copying large local files unless implementation constraints require it.

## Thread Lifecycle

Each thread should move through explicit states.

Suggested states:

- `created`
- `delivered`
- `in_progress`
- `awaiting_reply`
- `awaiting_user`
- `completed`
- `failed`

This state model is intentionally small. It supports planning, implementation, and review workflows without introducing workflow-engine complexity.

## Safety and Policy

Policy requirements for v1:

- New cross-agent tasks require an explicit user command from the CLI
- Autonomous follow-up is allowed only within an existing task thread
- The broker must preserve a local audit trail of thread messages and status changes
- Companions must not be allowed to spawn unrelated tasks without user initiation

These constraints keep the system useful without turning it into an uncontrolled agent loop.

## Example Use Cases

### Plan Review

- User asks Claude to draft a plan
- User runs `whisper tell codex "review this plan"`
- Codex returns review findings on the same thread

### Implementation Handoff

- Codex produces a plan and success criteria
- User runs `whisper tell claude "implement this approved plan"`
- Claude receives the thread packet and attached plan document

### Cross-validation

- Claude completes implementation and attaches diff references
- User runs `whisper tell codex "validate this diff against the plan"`
- Codex reviews based on the same thread history and artifacts

## Non-Goals

`ai-whisper` does not aim to:

- replace the native session memory of either agent
- synchronize every prompt and response between tools
- act as a general-purpose chat server
- manage broad project orchestration across many agents

## Open Implementation Questions

These are intentionally deferred to the implementation-planning stage:

- whether the broker API should use Unix sockets or localhost HTTP
- whether the shared store should be SQLite, JSONL, or another local format
- how each companion will request a handoff packet from its host agent session
- how artifact references should be normalized across repositories

## Recommended Next Step

After this architecture spec is approved, the next document should define:

- broker API contract
- task-thread and packet schemas
- companion protocol
- CLI command surface
- initial storage model

That decomposition is small enough to support a concrete implementation plan without expanding project scope.
