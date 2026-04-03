# ai-whisper Schema Design

**Date:** 2026-04-03

## Goal

Define the schema architecture for `ai-whisper` v1, including:

- canonical schema source
- schema organization strategy
- ID modeling
- versioning rules
- timestamp strategy
- transport versus persistence schema boundaries
- event schema modeling

This document defines how the type and validation layer should be structured. It does not define the final package file list or concrete wire payloads in full detail.

## Design Inputs

This design builds on the approved architecture and broker contract decisions:

- TypeScript + `zod` is the preferred contract model
- all broker payloads and persisted events should carry explicit version fields
- IDs should be branded strings with runtime validation
- domain objects should favor discriminated unions over loose optional-field objects
- schemas should be organized by domain aggregate
- transport and persistence schemas should be distinct and explicitly mapped
- event payloads should be modeled as discriminated unions
- strong reviewability and explicit typing are core design goals

## Canonical Schema Source

The canonical schema source for `ai-whisper` v1 should be TypeScript + `zod`.

### Design rule

- `zod` schemas are the runtime validation source of truth
- TypeScript types are inferred from the schemas where appropriate
- generated JSON schema may be produced later if required, but it is not the primary contract source in v1

### Rationale

This approach matches the project’s priorities:

- strong typing
- local code review clarity
- explicit validation at boundaries
- minimal duplication between type definitions and runtime checks

## Schema Package Role

The canonical contract layer should live in `packages/shared`.

This package should define:

- domain IDs
- transport payload schemas
- event schemas
- shared enums and literal sets
- schema-driven inferred types
- transport-to-persistence mapping contracts where needed

The goal is to centralize shared contract logic without putting persistence implementation or broker business logic into the schema package.

## Organization by Domain Aggregate

Schemas should be organized by domain aggregate, not by one global technical-type bucket.

### Recommended domain folders

- `collab/`
- `session/`
- `thread/`
- `work-item/`
- `artifact/`
- `event/`

### File layout guidance

Each domain may contain one or more focused files, depending on complexity.

Reasonable starting structure:

- `ids.ts`
- `schema.ts`
- `types.ts`

Additional files may be added when the domain grows, for example:

- `transitions.ts`
- `manifest.ts`
- `envelope.ts`

### Rationale

This keeps the code review experience coherent:

- domain rules stay close together
- files remain small and readable
- later growth does not force a giant catch-all schema file

## ID Modeling

All broker-level identifiers should be represented as branded string types in TypeScript and as validated strings at runtime.

### Design rule

- transport and persistence formats carry IDs as strings
- application code uses branded string types
- runtime parsing and validation must use centralized constructors or validators

### Example ID categories

- `CollabId`
- `SessionId`
- `ThreadId`
- `WorkItemId`
- `ArtifactManifestId`
- `EventId`

### Required ID capabilities

Each ID category should provide:

- a branded TypeScript type
- a `zod` string validator with a clear format rule
- a single parser or constructor path used at boundaries

### Rationale

This provides the best tradeoff for `ai-whisper`:

- lightweight storage and transport representation
- stronger TypeScript safety than plain strings
- better code review clarity than structured object IDs

## Shared Literals and State Values

State fields should be defined using shared literal sets that produce both:

- explicit runtime `zod` enums
- inferred TypeScript union types

### Design rule

Avoid loose string status fields and avoid numeric enums.

Instead, define stable literal sets for values such as:

- agent type
- thread state
- work item acknowledgement state
- transition intent
- artifact category
- event type

### Rationale

This keeps state vocabulary explicit and reviewable while preserving strong type inference.

## Versioning Rules

Every broker payload and every persisted event must carry an explicit schema version field.

### Scope

Version fields should appear on:

- control-plane request payloads
- control-plane response payloads
- event envelopes
- persisted event records
- transport-level domain records when they cross package boundaries

### Rationale

Even in v1, version omission creates avoidable ambiguity when:

- replaying older events
- migrating persisted state
- debugging mismatches between companions and broker code

Versioning should be explicit from the start.

## Timestamp Strategy

`ai-whisper` should use a hybrid timestamp model.

### Design rule

- external-facing payloads and event envelopes use ISO 8601 strings
- internal runtime logic and storage indexes may normalize timestamps to epoch milliseconds where useful

### Rationale

This balances two needs:

- human-readable logs and payload inspection
- efficient comparison and ordering in code or storage

The system is local-first and review-oriented, so external readability matters.

## Transport and Persistence Schema Separation

Transport schemas and persistence schemas must be modeled separately.

### Transport schema responsibilities

- define broker API contracts
- define companion-facing message structures
- define event envelopes and payloads
- validate ingress and egress boundaries

### Persistence schema responsibilities

- define normalized storage records
- reflect storage constraints and indexes
- represent stored state independently from transport concerns

### Design rule

Do not reuse one schema object everywhere just because the fields look similar in v1.

Instead:

- define transport records explicitly
- define persistence records explicitly
- use visible mapping functions or mapping modules between them

### Rationale

Transport models and storage models evolve for different reasons. Keeping them separate avoids accidental coupling and makes migrations easier to reason about.

## Domain Object Shape Rules

Whenever an entity can exist in multiple valid shapes based on status, kind, or role, the schema should use a discriminated union.

### Design rule

Prefer:

- explicit variants with required fields

Avoid:

- large flat objects with many optional fields and hidden invariants

### Example use cases

Discriminated unions are appropriate for:

- event payloads by event type
- reply variants by reply kind
- work item acknowledgment records by ack phase
- transition-intent-bearing payloads versus content-only payloads

### Rationale

This supports:

- stronger static type narrowing
- clearer human review
- fewer illegal field combinations

## Event Schema Model

Events should be modeled using a typed envelope plus a discriminated payload union keyed by event type.

### Event envelope responsibilities

An event envelope should carry:

- schema version
- event ID
- event type
- timestamp
- collaboration scope identifiers
- payload

### Event payload rule

The payload shape must be determined by the declared event type.

This means:

- `session.registered` has its own payload schema
- `workitem.queued` has its own payload schema
- `thread.transitioned` has its own payload schema

### Rationale

This makes event handling safer and replay behavior easier to inspect and debug.

## Mapping Boundaries

Explicit mapping layers should exist between:

- transport schemas and persistence schemas
- validated IDs and raw strings at input boundaries
- event envelopes and domain-specific handler inputs

These mappings should be visible in code, not hidden in ad hoc property copies spread across the codebase.

## Reviewability Standard

The schema layer should be readable enough that a reviewer can inspect one domain directory and answer:

- what identifiers exist in this domain
- which payload variants are allowed
- which fields are required for each variant
- which values are legal for each state field
- which records are transport-facing versus persistence-facing

If a reviewer cannot answer those questions locally, the schema organization is too implicit.

## Constraints and Non-Goals

This schema design intentionally does not define:

- exact regex patterns for every ID
- exact TypeScript file names for all schema modules
- final event payload field sets
- final persistence table layouts
- generated schema publication strategy

Those belong in the next technical documents.

## Recommended Next Technical Design

The next schema-adjacent design should define one of:

- the concrete domain schemas for collaboration, sessions, threads, work items, replies, and artifact manifests
- the `whisper collab` command flow mapped onto broker operations
- the companion registration and reconnect protocol

The best next step is likely the concrete domain schema set, because it will give the broker API and companion protocol a stable payload vocabulary.
