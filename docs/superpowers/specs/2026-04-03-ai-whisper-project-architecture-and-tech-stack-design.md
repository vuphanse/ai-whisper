# ai-whisper Project Architecture and Tech Stack Design

**Date:** 2026-04-03

## Goal

Define the implementation architecture and technology choices for `ai-whisper` v1 without expanding the product scope beyond the approved system architecture.

This document answers:

- how the codebase should be structured
- which runtime and core libraries should be used
- how session identity and collaboration scoping should work
- how the primary `whisper collab` workflow should behave at a technical level

## Design Inputs

This design builds on the approved system architecture and the following decisions:

- Platform support: macOS and Linux
- Broker exposure: transport abstraction with Unix socket on macOS/Linux and optional localhost HTTP adapter
- Runtime: Node.js + TypeScript
- Storage model: hybrid, with SQLite for thread state and filesystem storage for artifact metadata/cache
- Event model: subscription/event stream with polling or replay fallback
- Companion design: generic companion core with per-agent session adapters
- Broker startup: auto-started by the CLI when needed
- Primary session UX: `whisper collab`
- Collaboration scope: exactly one Codex session and one Claude session in v1
- Routing scope: workspace root + collaboration ID + session ID
- Collaboration ID: user-provided when present, otherwise auto-generated
- Terminal UX: prefer `tmux` for same-window split panes, otherwise fall back to separate terminal processes or windows

## Architectural Approach

The recommended architecture is a TypeScript monorepo with explicit package boundaries. The system should separate three concerns:

- product-facing commands and workflow entry points
- collaboration state and routing logic
- agent-specific integration behavior

That separation matters because the broker should remain generic even if Codex or Claude integration details change later.

## Monorepo Structure

The repo should use `pnpm` workspaces and be organized around six primary packages.

### `packages/shared`

Responsibilities:

- shared TypeScript types
- ID and state enums
- protocol request and response shapes
- schema validation definitions
- error categories

This package is the contract layer for the rest of the system.

### `packages/cli`

Responsibilities:

- implement the `whisper` command surface
- parse user intent
- bootstrap the broker when needed
- resolve workspace and collaboration context
- present thread and status output

This package should not own business rules for routing or persistence.

### `packages/broker`

Responsibilities:

- manage collaboration threads
- enforce routing and policy constraints
- coordinate persistence
- manage event subscriptions and replay
- track collaboration lifecycle state

The broker is the source of truth for collaboration state, but not for agent-specific behavior.

### `packages/companion-core`

Responsibilities:

- connect to the broker
- register session metadata
- receive incoming work
- request handoff and reply packets from the host adapter
- submit results back to the broker
- recover from disconnects or missed events

This package should stay generic and reusable for any future agent adapter.

### `packages/adapter-codex`

Responsibilities:

- implement the Codex session adapter contract
- translate broker or companion requests into Codex-compatible session actions
- expose session health and capabilities to the companion core

### `packages/adapter-claude`

Responsibilities:

- implement the Claude session adapter contract
- translate broker or companion requests into Claude-compatible session actions
- expose session health and capabilities to the companion core

## Core Interface Boundaries

The most important design rule is that the broker must not know how Codex or Claude produce replies. That work belongs to the session adapter layer.

Conceptual adapter interface:

```ts
export interface SessionAdapter {
  register(): Promise<SessionRegistration>;
  requestHandoff(input: HandoffRequest): Promise<HandoffPacket>;
  requestReply(input: ReplyRequest): Promise<ReplyPacket>;
  getHealth(): Promise<SessionHealth>;
  shutdown(): Promise<void>;
}
```

Key implications:

- `packages/broker` depends on protocol contracts, not agent implementations
- `packages/companion-core` depends on the `SessionAdapter` interface, not on Codex or Claude-specific broker rules
- agent-specific complexity stays isolated in `adapter-codex` and `adapter-claude`

## Runtime and Tooling Choices

### Runtime

- Node.js LTS
- TypeScript with `strict` mode enabled

TypeScript is the right tradeoff here because the system is coordination-heavy, schema-heavy, and meant to be reviewed and maintained directly by you.

### Package and Build Tooling

- `pnpm` workspaces for monorepo management
- `tsup` or `tsx`-based development tooling for package execution
- project references if compile-time boundaries become important

The repo should start simple and avoid a heavyweight build system unless package count or startup time demands it later.

### CLI

- `commander` for command parsing

The CLI surface is command-oriented and stable enough that `commander` is an appropriate fit without introducing framework overhead.

### Validation and Schemas

- `zod` for schema definitions and runtime validation

This is a central choice. `ai-whisper` relies on correct handoff packets, thread events, and routing metadata. Runtime validation is not optional.

### Broker Transport

- transport abstraction in broker code
- Unix socket as the preferred local transport on macOS and Linux
- optional localhost HTTP adapter for environments where socket transport is less convenient
- `fastify` if the HTTP adapter is enabled

This keeps the core system local-first while still allowing a consistent adapter boundary.

### Storage

- SQLite for collaboration threads, session registrations, lifecycle state, and event replay metadata
- filesystem storage for artifact metadata, logs, and cache-oriented material

This hybrid model keeps collaboration state queryable without forcing all artifact-related data into the database.

### Logging

- `pino`

This gives structured local logs without imposing heavy infrastructure choices.

### Testing

- `vitest` for unit and integration testing

The broker, schema layer, and companion behavior should be tested in-process where possible.

### Linting and Formatting

- `eslint`
- `prettier`

## Collaboration Identity Model

Identity must be specific enough to prevent accidental cross-talk when multiple agent sessions are open at the same time.

The routing key should be built from:

- `workspace_root`
- `collab_id`
- `session_id`

### `workspace_root`

The canonical workspace path where the collaboration is operating.

### `collab_id`

A human-friendly name when supplied by the user, otherwise an auto-generated opaque identifier.

Examples:

- `feature-x`
- `plan-review`
- `c_8f3c91`

### `session_id`

A unique identifier for a specific live session instance.

Examples:

- `codex:s_ab12`
- `claude:s_de45`

This makes the collaboration relation explicitly one-to-one for v1:

- one Codex session
- one Claude session
- one collaboration scope

Threads must remain bound to that scope unless the user explicitly creates a different collaboration.

## Primary UX Model

The primary user-facing workflow should live under `whisper collab`.

Representative commands:

```text
whisper collab start
whisper collab status
whisper collab tell codex "review this plan"
whisper collab tell claude "implement this approved plan"
whisper collab stop
```

### `whisper collab start`

Expected behavior:

- resolve the workspace root
- create or reuse a broker process
- create a collaboration scope with a `collab_id`
- launch one Codex session and one Claude session
- attach a companion to each
- bind both sessions to the same collaboration scope

### Terminal behavior

Preferred behavior:

- if `tmux` is available, open both sessions in the same terminal window using split panes

Fallback behavior:

- launch separate terminal processes or windows when `tmux` is unavailable or unsuitable

The key requirement is not pane style. The key requirement is that both launched sessions remain bound to the same collaboration scope automatically.

## Broker Lifecycle Model

The broker should be auto-started by the CLI when a command requires it and no healthy broker is available.

This avoids making users manually manage daemon state for normal operation.

Startup expectations:

- CLI checks for an existing broker bound to the current workspace context
- if missing, CLI starts the broker
- CLI waits for health confirmation
- command proceeds normally

The broker should remain a local background process for the duration of active collaboration use, with an explicit stop command available.

## Event and Recovery Model

The broker and companions should use a hybrid event model.

Primary mode:

- event subscription or streaming for normal low-latency collaboration

Recovery mode:

- polling or replay to recover after disconnects, broker restarts, or missed delivery windows

This is important because local long-running sessions are failure-prone in practice. Recovery behavior must be part of the architecture, not an afterthought.

## Storage Layout

The storage model should separate authoritative collaboration state from larger or less-structured materials.

### SQLite responsibilities

- collaboration registration
- session registration
- thread metadata
- message metadata
- lifecycle state
- event offsets or replay markers

### Filesystem responsibilities

- artifact references
- cached packet bodies if needed
- structured logs
- optional exported thread bundles

The exact directory layout can be specified in a follow-up design doc, but the boundary should stay consistent.

## Technical Non-Goals

This design does not attempt to define:

- detailed SQLite schema
- wire-level broker API format
- exact process-launch strategy per terminal emulator
- exact Codex or Claude adapter implementation details

Those belong in the next technical design layer, not in this architecture-and-stack document.

## Risks and Design Constraints

### 1. Session binding ambiguity

If session identity is not bound to `workspace_root + collab_id + session_id`, cross-talk between unrelated live sessions becomes likely.

### 2. Over-coupled package boundaries

If CLI, broker, and adapter behavior are mixed together, future maintenance becomes harder and failures become less diagnosable.

### 3. Broker transport leakage

If the rest of the codebase assumes one IPC mechanism directly, later transport changes become expensive.

### 4. Adapter instability

Codex and Claude integrations are the most likely integration boundary to evolve. They must remain isolated from core collaboration logic.

## Recommended Next Technical Design

The next technical document should define:

- broker API contracts
- collaboration and session schemas
- thread and packet event model
- companion registration flow
- `whisper collab` command behavior in more detail

That is the right level of detail before writing an implementation plan.
