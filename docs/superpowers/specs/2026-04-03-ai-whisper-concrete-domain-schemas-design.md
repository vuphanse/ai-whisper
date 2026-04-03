# ai-whisper Concrete Domain Schemas Design

**Date:** 2026-04-03

## Goal

Define the primary transport-facing domain entities for `ai-whisper` v1 and their relationships:

- `Collab`
- `Session`
- `Thread`
- `WorkItem`
- `Reply`
- `ArtifactManifest`
- `EventEnvelope`

This document defines the conceptual schema set that later API contracts and persistence models should map to.

## Design Inputs

This design builds on the approved schema architecture and broker contract:

- `Reply` is a first-class entity
- thread ordering uses canonical turn index plus timestamps
- each `WorkItem` targets exactly one session
- initial work items require full context packets
- follow-up work items may use validated delta packets
- thread state and work item state are separate enums
- `Reply` has its own independent `kind`
- artifact manifests belong to the thread and are attached through work items or replies
- `WorkItem` requires typed `requested_action` plus optional natural-language instruction
- reply kinds are independent from request actions
- failure is modeled primarily through `Reply.kind = "failure"` with optional lifecycle transition

## Entity Set Overview

`ai-whisper` v1 should use an explicit conversation domain model. The system should not collapse requests and responses into one generic turn object.

The domain boundary should be:

- `Collab` for collaboration scope
- `Session` for live agent identity
- `Thread` for topic-level collaboration state
- `WorkItem` for directed actionable turns
- `Reply` for response records
- `ArtifactManifest` for attached artifacts
- `EventEnvelope` for broker event transport

This separation keeps the model reviewable and avoids overloading one entity with multiple responsibilities.

## `Collab`

### Purpose

Represents one collaboration scope between exactly one Codex session and one Claude session in one workspace.

### Required conceptual fields

- `version`
- `collab_id`
- `workspace_root`
- `display_name`
- `status`
- `created_at`
- `updated_at`

### Role in the system

- defines the routing scope for all threads, sessions, work items, and events
- prevents cross-talk between unrelated live sessions
- acts as the top-level container for v1 collaboration state

## `Session`

### Purpose

Represents one active live agent session attached to a collaboration scope.

### Required conceptual fields

- `version`
- `session_id`
- `collab_id`
- `agent_type`
- `registration_state`
- `health_state`
- `capabilities`
- `registered_at`
- `last_seen_at`

### Role in the system

- identifies the specific Codex or Claude live session participating in the collaboration
- provides the broker with a stable delivery target
- supports reconnect, health monitoring, and session trust handling

## `Thread`

### Purpose

Represents one collaboration topic or task inside a collaboration scope.

### Required conceptual fields

- `version`
- `thread_id`
- `collab_id`
- `title`
- `thread_state`
- `base_context_ref`
- `current_turn_index`
- `created_by_session_id`
- `created_at`
- `updated_at`

### Role in the system

- serves as the durable context container for a topic or task
- owns canonical lifecycle state
- anchors ordered work item and reply history
- provides the broker with the authoritative boundary for autonomous follow-up

## `WorkItem`

### Purpose

Represents one directed actionable turn inside a thread.

### Required conceptual fields

- `version`
- `work_item_id`
- `thread_id`
- `collab_id`
- `turn_index`
- `sender_session_id`
- `target_session_id`
- `requested_action`
- `instruction`
- `context_packet`
- `delivery_state`
- `artifact_manifest_ids`
- `created_at`
- `delivered_at`
- `completed_at`

### Role in the system

- captures the sender’s request to the target session
- defines the actionable payload delivered by the broker
- gives the thread a stable request-side turn record

### Context rules

- the first work item in a thread must carry a full context packet
- follow-up work items may carry a delta context packet only when the broker can validate an existing base context for the thread

### Targeting rule

- each work item targets exactly one session

This matches the v1 collaboration contract of one Codex session paired with one Claude session.

## `Reply`

### Purpose

Represents the first-class response to a work item.

### Required conceptual fields

- `version`
- `reply_id`
- `thread_id`
- `collab_id`
- `work_item_id`
- `source_session_id`
- `turn_index`
- `kind`
- `content`
- `transition_intent`
- `artifact_manifest_ids`
- `created_at`

### Role in the system

- stores response-side conversation history explicitly
- carries semantic reply meaning independent from lifecycle state
- enables event references, auditability, and future thread operations to point to stable reply records

### Failure rule

Failure should be modeled primarily as:

- `Reply.kind = "failure"`

The reply may also request a lifecycle transition such as:

- `transition_intent = "failed"`

This preserves explanation and state change as related but distinct facts.

## `ArtifactManifest`

### Purpose

Represents a thread-owned manifest for referenced files, diffs, and generated docs or plans.

### Required conceptual fields

- `version`
- `artifact_manifest_id`
- `thread_id`
- `collab_id`
- `produced_by_session_id`
- `artifact_category`
- `entries`
- `summary`
- `created_at`

### Role in the system

- centralizes artifact references into stable objects
- avoids scattering raw path metadata throughout replies and work items
- allows thread inspection to treat artifacts as first-class references

### Ownership rule

- manifests belong to the thread
- work items and replies attach to manifests through explicit relationships

This allows the thread to remain the durable context container while preserving who introduced each artifact.

## `EventEnvelope`

### Purpose

Represents the broker’s typed event transport wrapper.

### Required conceptual fields

- `version`
- `event_id`
- `event_type`
- `collab_id`
- `workspace_root`
- `timestamp`
- `payload`

### Role in the system

- carries broker facts to companions and observers
- supports replay and recovery
- provides a stable audit log boundary between broker actions and broker-observed outcomes

## Ordering Model

The broker should maintain canonical thread order using:

- explicit `turn_index`
- timestamps as secondary diagnostic and ordering metadata

### Ordering rule

- the broker controls `turn_index`
- clients must not assign canonical order independently

### Rationale

Timestamps alone are insufficient as the sole source of conversational order in a local, reconnectable system. Canonical turn indices make thread history easier to reason about.

## State Model

The concrete schemas should treat these as separate vocabularies:

- `ThreadState`
- `WorkItemState`
- `ReplyKind`

### `ThreadState`

Represents collaboration-level lifecycle state.

Examples:

- `in_progress`
- `awaiting_user`
- `completed`
- `failed`

### `WorkItemState`

Represents delivery and processing lifecycle for a directed request.

Examples:

- `queued`
- `delivered`
- `completed`
- `failed`

### `ReplyKind`

Represents the semantic kind of response.

Examples:

- `answer`
- `review`
- `clarification`
- `failure`

### Rationale

These fields answer different questions and must not be collapsed into one status system.

## Action Model

Each work item must carry:

- a typed `requested_action`
- an optional natural-language `instruction`

### Example action categories

- `review_plan`
- `implement_plan`
- `review_diff`
- `validate_against_plan`
- `answer_question`
- `request_clarification`

### Design rule

`requested_action` and `ReplyKind` must remain independent vocabularies.

### Rationale

Requests and replies have different semantics. Mirroring them would create avoidable ambiguity.

## Context Packet Model

The work item context model should support two valid packet shapes:

- `full`
- `delta`

### `full`

Used for the first work item in a thread. Must be self-sufficient.

Expected conceptual contents:

- goal
- current state
- decisions made
- assumptions
- relevant artifacts
- open questions
- requested action
- success criteria

### `delta`

Used only for follow-up work items when the thread already has a valid base context.

Expected conceptual contents:

- base context reference
- changed assumptions or decisions
- newly attached artifacts
- updated instruction or requested action nuance

### Validation rule

The broker must reject a delta packet if no valid base context is established in the thread.

## Artifact Attachment Model

Artifacts are thread-owned but introduced through work items or replies.

### Attachment rule

The system should preserve attachment edges that indicate whether a manifest was introduced by:

- a work item
- a reply

### Rationale

This gives the thread durable artifact ownership while preserving conversational provenance.

## Relationship Summary

The conceptual relationships should be:

- one `Collab` has exactly two active v1 `Session` roles
- one `Collab` has many `Thread`s
- one `Thread` has many `WorkItem`s
- one `Thread` has many `Reply`s
- one `WorkItem` has zero or one primary `Reply` in v1
- one `Thread` has many `ArtifactManifest`s
- one `WorkItem` may reference many manifests
- one `Reply` may reference many manifests
- one `EventEnvelope` describes one broker fact tied to a collaboration scope

## Constraints and Non-Goals

This document intentionally does not define:

- exact `zod` schemas for each field
- final enum member lists
- exact ID regex patterns
- final persistence record layout
- exact event payload field definitions

Those belong in the next layer of schema and API specification.

## Recommended Next Technical Design

The next technical design should define:

- exact field-level transport schemas for each entity
- exact event payload variants
- reply-to-work-item cardinality rules in more detail
- `whisper collab` command flow mapped onto these domain entities
- companion registration and delivery protocol mapped onto these domain entities

That will create a stable contract surface before implementation planning.
