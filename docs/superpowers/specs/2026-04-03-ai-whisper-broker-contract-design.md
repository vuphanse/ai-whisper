# ai-whisper Broker Contract Design

**Date:** 2026-04-03

## Goal

Define the broker contract for `ai-whisper` v1, including:

- control-plane API shape
- event stream model
- work item delivery semantics
- session trust and registration
- thread transition rules
- artifact manifest handling
- authoritative state boundaries

This document does not define wire formats or final database schema. It defines the contract model that later technical specs and implementation plans must follow.

## Design Inputs

This design builds on the approved product and project architecture decisions:

- mixed control-plane broker model
- Node.js + TypeScript monorepo
- local-first transport with Unix socket preference and optional localhost HTTP adapter
- SQLite as the authoritative state store with durable event history
- event subscription with replay or polling fallback
- one Codex session and one Claude session per collaboration scope in v1
- routing identity based on `workspace_root + collab_id + session_id`
- broker-issued session trust after registration
- work delivered as thread-scoped work items
- two-phase acknowledgement: `delivered` then `completed` or `failed`
- reply packets may include typed transition intents validated by the broker
- artifacts represented through broker-managed manifests

## Contract Overview

The broker exposes two cooperating interfaces:

1. Control API
2. Event Stream

The design rule is:

- control API expresses intent
- event stream records facts

This keeps command handling explicit while preserving an auditable, replayable collaboration history.

## Control API

The control API is used by the CLI and companions for explicit operations.

### Responsibilities

- create and manage collaboration scopes
- register and validate sessions
- create and inspect threads
- enqueue work items
- post replies
- attach artifact manifests
- query current state
- shut down or stop active collaboration scopes

### Core operations

The exact method names may vary during implementation, but the operation surface should include at least the following:

- `startCollab`
- `getCollab`
- `stopCollab`
- `registerSession`
- `getSessionHealth`
- `createThread`
- `getThread`
- `listThreads`
- `enqueueWorkItem`
- `ackWorkDelivered`
- `postReply`
- `attachArtifactManifest`
- `listArtifactManifests`

### Control API design rules

- Each mutation must validate collaboration scope and session identity
- Control operations must be idempotent where practical
- Every accepted mutation must emit a corresponding broker event
- The broker, not the client, remains authoritative for thread lifecycle state

## Event Stream

The event stream is the broker’s fact channel. It is consumed primarily by companions and optionally by CLI inspection tools.

### Responsibilities

- notify target sessions of newly queued work
- notify listeners of thread lifecycle changes
- support replay after disconnect or restart
- surface broker and session health events

### Core event categories

- `collab.started`
- `session.registered`
- `session.attached`
- `session.disconnected`
- `thread.created`
- `workitem.queued`
- `workitem.delivered`
- `reply.posted`
- `thread.transitioned`
- `artifact.manifest_attached`
- `broker.replay_required`

### Event stream design rules

- Events must be append-only
- Events must be ordered within a collaboration scope
- Consumers must be able to resume from a known offset or replay marker
- Event payloads should be descriptive enough for recovery, not only for UI display

## Work Item Model

The broker’s delivery unit is a `work_item`, not a raw message.

This is required because a receiving agent needs task context, requested action, and artifact references together, not as loosely related records.

### Required work item responsibilities

A work item should identify:

- collaboration scope
- thread ID
- sender session ID
- target session ID
- requested action
- structured context packet
- attached artifact manifest IDs
- creation timestamp
- delivery state

### Why work items are thread-scoped

The thread is the long-lived collaboration context. The work item is the unit of actionable delivery inside that thread. This allows:

- multiple directed turns in one thread
- autonomous follow-up within the approved collaboration scope
- stable review and validation history over time

## Acknowledgement Model

`ai-whisper` v1 uses a two-phase acknowledgement model.

### Phase 1: Delivery acknowledgement

The target companion confirms it received the work item:

- `delivered`

This means the broker can stop retrying immediate delivery.

### Phase 2: Terminal processing acknowledgement

The target companion eventually reports one of:

- `completed`
- `failed`

This means the work item reached a terminal outcome for v1.

### Design rationale

Two-phase acknowledgement is the correct compromise:

- more informative than a single receive ack
- much simpler than a full workflow-state protocol
- expandable later into richer states such as `blocked`, `opened`, or `awaiting_user`

## Session Registration and Trust Model

The broker should trust only local participants, but local access alone is not a sufficient application-level boundary.

### Registration flow

1. A companion connects through the local broker transport.
2. The companion submits registration metadata:
   - workspace root
   - collab ID
   - session ID
   - agent type
   - adapter capabilities
3. The broker validates the collaboration scope.
4. The broker issues a broker-scoped session secret.
5. Future session operations must present that secret.

### Trust model

The security boundary is layered:

- local-only transport
- operating system socket or filesystem permissions
- broker-issued session secret after registration

This is intentionally local and pragmatic. It is stronger than blind local trust without introducing a remote auth system.

## Thread and Reply Model

Threads are the durable collaboration containers. Replies are directed additions to thread history that may also request a typed state transition.

### Thread responsibilities

A thread should represent:

- one collaboration topic or task
- stable participant context
- ordered work item and reply history
- lifecycle state
- related artifact manifests

### Reply responsibilities

A reply should include:

- source session ID
- thread ID
- content payload
- optional artifact manifest IDs
- optional typed transition intent
- reply timestamp

## Typed Transition Intents

Replies may include a typed `transition_intent`, but the broker remains authoritative.

### Example transition intents

- `in_progress`
- `awaiting_user`
- `completed`
- `failed`

### Validation rule

The broker must validate:

- whether the transition is legal from the current thread state
- whether the session is allowed to propose it
- whether required reply content or artifact references are present

If valid:

- broker applies the transition
- broker updates authoritative thread state
- broker emits `thread.transitioned`

If invalid:

- broker rejects the transition intent
- broker may still persist the reply content if policy allows

### Design rationale

This keeps replies expressive and compact while avoiding uncontrolled thread mutation by companions.

## Artifact Manifest Model

Artifacts should be broker-managed through manifests referenced by ID.

### Why manifests exist

Raw path attachments scattered across replies and work items would produce inconsistent state and make thread inspection harder. A manifest creates a stable reference object.

### Manifest responsibilities

An artifact manifest should describe:

- manifest ID
- producing session ID
- artifact category
- referenced file paths
- diff references
- generated document or plan references
- lightweight metadata such as checksum, timestamp, and optional summary

### Usage rule

- work items reference artifact manifest IDs
- replies reference artifact manifest IDs
- the broker records manifest attachment events

This keeps artifact handling explicit and queryable.

## Authoritative State Model

The broker should maintain authoritative current state in normalized SQLite tables and preserve durable event history in an append-only event log.

### Current-state responsibilities

At minimum, the broker should track:

- collaboration scopes
- registered sessions
- threads
- work items
- replies
- artifact manifests
- delivery state
- lifecycle state

### Event-log responsibilities

The event log should support:

- replay after companion disconnect
- audit of collaboration history
- recovery after broker restart
- future debugging and protocol inspection

### Design rationale

Pure event-sourcing is heavier than v1 needs. Current-state tables alone are too weak for recovery and replay. The hybrid model is the correct middle ground.

## Recovery Rules

The broker contract must assume disconnects and restarts are normal, not exceptional.

### Required recovery behavior

- companions reconnect using collaboration scope and session identity
- companions resume from last known event offset or replay marker
- broker can emit `broker.replay_required` when the client position is no longer valid
- control API reads must always reflect authoritative current state, regardless of replay status

This ensures the collaboration model remains stable even when local long-running sessions are interrupted.

## Constraints and Non-Goals

This contract intentionally does not define:

- exact transport frame formats
- final HTTP route structure
- exact Unix socket command encoding
- exact SQLite schema
- rich multi-stage work processing states beyond the two-phase acknowledgement model

Those belong in later technical design documents and implementation planning.

## Recommended Next Technical Design

The next design doc should define:

- concrete broker API endpoints or method contracts
- event payload schema set
- thread, work item, reply, and manifest schemas
- companion registration and reconnect flow
- `whisper collab` command behavior mapped onto broker operations

That is the right next layer before implementation planning.
