# ai-whisper Companion Protocol Design

**Date:** 2026-04-03

## Goal

Define the companion protocol for `ai-whisper` v1, including:

- companion lifecycle model
- startup and session binding
- registration and trust establishment
- host interaction boundaries
- timeout and retry behavior
- reconnect and replay rules
- health signaling
- capability reporting
- outbound buffering during broker unavailability

This document defines how live Codex and Claude sessions attach to the brokered collaboration model.

## Design Inputs

This design builds on the approved architecture, broker contract, and domain schema decisions:

- primary collaboration flow uses one Codex session and one Claude session per collab
- primary launch path is `whisper collab start`
- companions should use a hybrid lifecycle: long-lived sidecar in the primary flow, on-demand helper in fallback cases
- launcher injects intended collab and session context; broker validates and finalizes registration
- companion-to-host interaction uses structured request and reply boundaries
- direct broker-valid packets are preferred, with adapter normalization allowed as fallback
- companion owns local timeout and retry behavior
- broker owns outer delivery deadlines
- reconnect should attempt automatic resume first and explicit reattach second
- liveness should use heartbeat plus passive signals
- capability reporting should combine baseline registration with optional dynamic updates
- outbound messages should use bounded durable local buffering when the broker is temporarily unavailable

## Protocol Overview

The companion protocol should treat the companion as the stable local bridge between:

- the broker
- the live agent session
- the host-specific adapter

The companion is not just a thin transport client. It is the local coordination runtime responsible for maintaining a session’s participation in a collaboration scope.

## Lifecycle Model

`ai-whisper` v1 should use a hybrid companion lifecycle.

### Primary mode

- one long-lived companion sidecar per live Codex or Claude session
- started as part of `whisper collab start`
- remains active for the duration of the paired collaboration session

### Fallback mode

- bounded on-demand helper execution for attach, reattach, or manual recovery flows
- used when the primary launch path is unavailable or when a session must be reconnected later

### Rationale

The long-lived sidecar is the correct default for stable collaboration, replay, and health reporting. The helper path exists to keep the system recoverable and usable outside the ideal startup flow.

## Startup and Session Binding

The launcher should provide the companion with intended identity and routing context at startup.

### Injected startup context

- `workspace_root`
- `collab_id`
- `session_id`
- `agent_type`
- broker endpoint

### Binding rule

The companion proposes this identity and scope to the broker, but the broker finalizes registration.

### Rationale

This preserves the strong session-pair binding needed to avoid cross-talk between unrelated Codex or Claude sessions, while keeping the broker authoritative.

## Registration Flow

Registration should be explicit and stateful.

### Registration sequence

1. Companion connects to the local broker transport.
2. Companion submits registration metadata.
3. Registration metadata includes:
   - workspace root
   - collab ID
   - session ID
   - agent type
   - baseline capabilities
4. Broker validates the collaboration scope.
5. Broker issues a broker-scoped session secret.
6. Companion stores that secret for future calls.
7. Broker emits registration-related events.

### Broker authority rule

The broker remains authoritative for:

- whether the session may join the collab
- whether the proposed scope is valid
- whether an existing session registration may be resumed

## Host Interaction Model

When a work item arrives, the companion must interact with the live host session through a structured request and reply boundary.

### Interaction rule

The companion does not treat the host as an uncontrolled free-form stream.

Instead, it:

1. receives a work item from the broker
2. invokes the host adapter with a structured request
3. waits for a bounded structured result
4. validates or normalizes the result
5. submits the resulting packet to the broker

### Preferred output mode

- host session produces a broker-valid handoff or reply packet directly

### Fallback output mode

- host session produces a host-native result
- adapter normalizes that result into a broker-valid packet before submission

### Rationale

This preserves explicit packet boundaries, makes validation possible, and avoids relying on raw prompt-stream scraping as the system’s core interaction model.

## Timeout and Retry Model

The companion should own local timeout handling when waiting for the host session to produce a structured result.

### Local timeout responsibilities

- detect slow or unresponsive host behavior
- retry bounded host interaction attempts
- track retry count and retry outcomes
- report timeout and retry information to the broker

### Broker timeout responsibilities

- enforce the outer delivery deadline for a work item
- determine when the work item reaches terminal failure at the broker level

### Design rule

The companion should retry before declaring local failure, but retries must remain bounded.

### Rationale

This creates a layered failure model:

- the companion handles local instability pragmatically
- the broker preserves authoritative lifecycle control

## Reconnect and Replay

Reconnect should use a hybrid strategy.

### Preferred reconnect path

- resume automatically from the last acknowledged event offset or replay marker

### Fallback reconnect path

- perform an explicit reattach flow if the broker rejects the resume position or requires stronger validation

### Required behavior

- companion must persist the last known replay position or equivalent marker
- broker may require replay when the client view is stale or invalid
- companion must tolerate broker restart and transient transport failure

### Rationale

Automatic resume minimizes friction, while explicit reattach preserves correctness when optimistic recovery is not safe.

## Health Signaling

Companion liveness should use a hybrid model.

### Active liveness

- periodic heartbeat sent to the broker

### Passive liveness

- recent event consumption
- recent control-plane activity
- recent successful reply or acknowledgement submission

### Design rule

The broker should not rely exclusively on heartbeats to decide session health.

### Rationale

Passive signals often reflect real operational health better than heartbeat alone, while heartbeats still provide a clear liveness baseline.

## Capability Reporting

Capability reporting should also use a hybrid model.

### Baseline capability registration

At registration time, the companion should declare stable baseline capabilities such as:

- supported interaction modes
- supported packet types
- normalization support
- buffering support

### Dynamic updates

The companion may later send updates if the host session’s effective capabilities change.

Examples:

- degraded host responsiveness
- temporary inability to produce direct broker-valid packets
- adapter-level recovery mode

### Broker interpretation rule

The broker should treat baseline capability registration as the stable floor, and dynamic updates as current operational state.

## Outbound Buffering

If the broker becomes temporarily unavailable, the companion should not immediately discard outbound replies or acknowledgements.

### Required buffering behavior

- use a bounded durable local queue
- persist queued outbound records locally
- resubmit when broker connectivity is restored
- enforce expiry rules
- enforce backpressure rules

### Design rule

Buffering must be bounded and observable. It must not become an unbounded hidden backlog.

### Rationale

This protects in-flight work from transient broker failures while keeping failure modes debuggable and operationally safe.

## Responsibility Boundaries

### Broker responsibilities

- authoritative thread and work item state
- delivery acceptance
- session registration validation
- replay validity
- outer deadline enforcement

### Companion responsibilities

- local session participation runtime
- host interaction orchestration
- bounded retry logic
- reconnect attempts
- heartbeat and passive liveness contribution
- bounded local buffering

### Adapter responsibilities

- tool-specific integration with Codex or Claude host sessions
- structured request delivery into the host
- direct packet extraction or host-native response normalization
- host capability reporting input

## Constraints and Non-Goals

This protocol design intentionally does not define:

- exact adapter APIs
- exact heartbeat interval values
- exact retry counts or timeout durations
- final local buffer file format
- exact replay token encoding

Those belong in later protocol and implementation planning documents.

## Recommended Next Technical Design

The next technical design should define:

- `whisper collab` command flow and launcher behavior
- concrete companion registration and reply payload schemas
- exact broker API operations used by companions
- Codex and Claude adapter boundary contracts

The strongest next step is the `whisper collab` command-flow design, because it will connect the launcher, broker, companions, and user-facing workflow into one operational model.
