# ai-whisper Implementation Roadmap

**Date:** 2026-04-03

## Goal

Deliver `ai-whisper` incrementally in small phases, where each phase ends in working, testable software and reduces uncertainty for the next phase.

## Phase 1: Foundation

**Goal:** Establish the monorepo, developer tooling, workspace scripts, and package boundaries without taking on broker or provider logic yet.

**Deliverables:**

- `pnpm` workspace
- TypeScript base config
- root lint, format, test, and typecheck workflows
- initial package skeletons:
  - `packages/shared`
  - `packages/cli`
  - `packages/broker`
  - `packages/companion-core`
  - `packages/adapter-codex`
  - `packages/adapter-claude`
- root README
- smoke tests proving the workspace is wired correctly

**Exit criteria:**

- `pnpm test` passes
- `pnpm typecheck` passes
- `pnpm lint` passes
- every package builds cleanly

## Phase 2: Shared Contracts and Broker Skeleton

**Goal:** Implement the shared contract layer and a minimal broker runtime that can start, expose health, and persist basic state.

**Deliverables:**

- branded IDs and core literal sets
- transport schemas and event envelope skeletons
- persistence model skeleton
- SQLite bootstrap and migration mechanism
- broker process with health/status surface
- storage and schema tests

**Exit criteria:**

- broker starts locally
- health endpoint or socket status works
- initial schema and persistence tests pass

## Phase 3: Collaboration and Thread Engine

**Goal:** Add collaboration state management and the core thread/work-item/reply lifecycle inside the broker.

**Deliverables:**

- collab creation and lookup
- session registration and trust scaffolding
- thread creation and active-thread behavior
- work-item enqueue and delivery records
- reply submission and thread transition handling
- artifact manifest creation and attachment
- event stream plus replay markers

**Exit criteria:**

- one process can simulate both sides of a collab
- work items and replies move through the broker correctly
- thread and event-state tests pass

## Phase 4: Companion Runtime and Generic Provider Layer

**Goal:** Make the live session protocol real with `companion-core` and a host-agnostic provider contract, using a mock provider before real Codex/Claude integration.

**Deliverables:**

- companion registration flow
- reconnect and replay behavior
- heartbeat and passive health signals
- bounded buffering for outbound messages
- provider contract and built-in registry
- mock provider for deterministic end-to-end tests

**Exit criteria:**

- a mock provider can attach, receive work, and return replies
- replay and reconnect paths are exercised in tests
- provider contract tests pass

## Phase 5: Real User Workflow

**Goal:** Ship the actual paired-session UX with `whisper collab`, built-in Codex/Claude providers, and in-session relay.

**Deliverables:**

- `whisper collab start`, `status`, and shutdown flows
- `tmux`-preferred launcher with fallback behavior
- Codex and Claude built-in providers
- relay interception for `@@codex ...` and `@@claude ...`
- local acknowledgement messages
- concise reply summaries in the origin session
- inspection and recovery commands

**Exit criteria:**

- a real paired Codex/Claude session can collaborate through the broker
- active-thread relay works
- status and recovery flows work

## Recommended Execution Order

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5

## Why This Split

- Phase 1 keeps the repo healthy before any real behavior is added.
- Phase 2 and Phase 3 validate the core state model before terminal integration.
- Phase 4 proves the protocol using a mock provider, which is much cheaper than debugging Codex/Claude integration too early.
- Phase 5 is intentionally last because terminal/tool integration is the most fragile part of the system.

## Recommended Next Action

Execute Phase 1 first and do not start Phase 2 until:

- the workspace layout is stable
- the scripts are reliable
- the package boundaries feel right

That keeps the rest of the implementation from being built on weak scaffolding.
