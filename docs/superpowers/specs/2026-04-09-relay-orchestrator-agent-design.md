# Relay Orchestrator Agent — Design Spec

**Date:** 2026-04-09
**Branch:** feat/turn-owned-mounted-relay-handoff
**Status:** Approved, ready for implementation planning

---

## Background

Current baton handoff workflow requires human operator to press hotkeys (a/d/e/space/h) to accept, defer, decline, amend, or hand back the turn. This is intentional for human-in-the-loop control but creates friction when the returning result still needs another implement/review pass.

This spec introduces a `RelayOrchestrator` daemon that automates only the post-handback judgment loop. It does not replace owner-side accept/defer/decline/handoff controls in mounted runtime. Instead, the orchestrator reads handoff records after each explicit `handed_back` event, determines whether the deliverable satisfies the request, and either closes the chain, triggers another loop, or escalates out of automation back to normal human-driven baton workflow.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Broker (SQLite)                │
│  State machine: pending→accepted→handed_back     │
│  Emits: HandoffEvent stream                      │
└────────────────────┬────────────────────────────┘
                     │ HandoffEvent{handed_back}
                     ▼
┌─────────────────────────────────────────────────┐
│          RelayOrchestrator (new daemon)          │
│                                                  │
│  1. Subscribe to broker handoff events           │
│  2. On handed_back → call LLM evaluator          │
│  3. Parse verdict: done | loop(N) | escalate     │
│  4. Write next action back to broker             │
└──────────┬─────────────────────┬────────────────┘
           │ loop                │ escalate
           ▼                     ▼
   broker.createLoopHandoff() broker.markEscalated()
   (create next round)        (surface to human operator)
```

**Key invariants:**
- Broker never calls LLM — stays pure state machine
- Orchestrator never writes SQLite directly — always via broker API
- Loop counter tracked per handoff chain (not per session)
- Escalation cap: configurable `maxRounds` (default 3)
- `orchestratorEnabled` is opt-in per collab — existing collabs unaffected
- Manual mounted-runtime controls remain source of truth before explicit handback

### Chain Identity And Persistence

Orchestrator decisions depend on durable chain state, not inferred in-memory state.

Each orchestrated handoff record must persist:

```ts
interface RelayHandoff {
  handoffId: string;
  chainId: string;              // stable for whole review/implement loop
  parentHandoffId: string | null;
  roundNumber: number;          // 1-based within chain
  rootRequestText: string;      // original request that started chain
  requestText: string;          // operator-visible task for this round
  handbackText: string | null;  // explicit returned payload captured at handback
}
```

Broker must also persist enough orchestrator bookkeeping to support restart-safe polling and idempotency:

```ts
interface RelayHandoffOrchestratorState {
  orchestratorStatus: "idle" | "pending" | "processed";
  orchestratorVerdict: "done" | "loop" | "escalate" | null;
  orchestratorReason: string | null;
  orchestratorClaimedAt: string | null;
  orchestratorEvaluatedAt: string | null;
}
```

`orchestratorStatus` semantics:

- `idle` = handed back and eligible for orchestration
- `pending` = atomically claimed by exactly one orchestrator worker, evaluation in progress
- `processed` = terminal orchestration decision already persisted

Polling should target handed-back records whose `orchestratorStatus === "idle"` rather than relying only on a process-local last-seen cursor.
Before any LLM call or forced re-issue path runs, the worker must atomically claim the handoff by flipping `idle -> pending` through broker API. If the compare-and-set claim fails, another worker already owns evaluation and this worker must noop.

---

## LLM Evaluator Contract

### Input

The orchestrator passes the handoff record to the LLM evaluator:

```ts
interface EvaluatorInput {
  rootRequestText: string;   // original request that started chain
  requestText: string;       // exact task sent in current round
  handbackText: string;      // explicit returned payload captured at handback
  senderAgent: string;       // who sent the baton for this round
  targetAgent: string;       // who did the work for this round
  roundNumber: number;       // current loop iteration (1-based)
  maxRounds: number;         // escalation cap
  captureStatus:             // how the handback payload was captured
    | "ok"                           // high-confidence capture, handbackText is reliable
    | "no_response_captured_confidently" // capture attempted but confidence check failed; handbackText is empty
    | "no_response_captured"         // capture produced nothing; handbackText is empty
    | null;                          // handback was manual (not via autonomous idle path)
}
```

### Model

`claude-haiku-4-5-20251001` via Anthropic SDK. Chosen for low latency, low cost, and reliable structured output via tool use. Local model support (e.g., Ollama) deferred until cloud path is proven.

### System Prompt Role

Neutral judge — not Codex, not Claude. Reads request vs. response, determines if deliverable satisfies the request without bias toward either agent.

### Output

Structured JSON verdict:

```json
{
  "verdict": "done" | "loop" | "escalate",
  "confidence": 0.0–1.0,
  "reason": "short explanation",
  "followUpMessage": "injected into next handoff if loop"
}
```

`followUpMessage` is only present when `verdict === "loop"`.

It is reviewer guidance for next round, not a replacement for durable chain context.

### Decision Rules (baked into prompt)

| Condition | Verdict |
|---|---|
| Reviewer explicitly approves, or response fully satisfies request | `done` |
| Reviewer has findings, implementer needs another pass | `loop` |
| `captureStatus === "no_response_captured"` | `loop` (forced, skip LLM — re-issue task unchanged) |
| `captureStatus === "no_response_captured_confidently"` | `loop` (forced, skip LLM — re-issue task unchanged; prior partial output is not preserved) |
| `roundNumber >= maxRounds` | `escalate` (forced, overrides LLM) |
| Ambiguous or contradictory response | `escalate` |
| `confidence < 0.5` | `escalate` |
| LLM call fails after 1 retry | `escalate` (safe default) |

---

## Orchestrator Lifecycle

### Startup

Orchestrator starts alongside the relay, launched by broker daemon or `collab start` when `orchestratorEnabled=true` for the collab. Subscribes to broker handoff events on init via **polling** (broker is SQLite-backed, no native event emitter). Orchestrator polls for newly `handed_back` handoffs at a configurable interval (default 1s), filtering for records whose persisted orchestrator status is `idle`, then atomically claiming them before evaluation.

### Per-Event Flow

```
handed_back event received
  → look up handoff record
  → check: orchestratorEnabled for this collab?
  → broker.claimHandoffForOrchestration(handoffId)? if no → noop
  → if captureStatus forces re-issue → skip LLM
    else call LLM evaluator (async, non-blocking to broker)
  → on verdict:
       done      → broker.resolveChain(chainId)
       loop      → broker.createLoopHandoff(sender↔target swapped, composed follow-up request)
       escalate  → broker.markEscalated(handoffId, reason)
```

### New Broker API Methods

These methods do not exist today and must be added to the broker:

- `broker.claimHandoffForOrchestration(handoffId)` — atomic compare-and-set claim from `orchestratorStatus: "idle"` to `"pending"`; returns claimed record on success, `null` on contention/no-op
- `broker.resolveChain(chainId)` — marks chain as `done`, no further orchestrator action
- `broker.markEscalated(handoffId, reason)` — marks chain as `escalated`, stores verdict metadata, and disables further automatic looping for that chain
- `broker.createLoopHandoff(...)` — creates next handoff in same chain with incremented round metadata

Any broker method that completes an orchestrator decision must also finalize the claimed handoff's orchestrator bookkeeping in the same broker transaction:

- set `orchestratorStatus = "processed"`
- persist `orchestratorVerdict`, `orchestratorReason`, and `orchestratorEvaluatedAt`
- preserve idempotency by making duplicate finalization a noop

### New Broker State Fields

```ts
// Added to RelayTurnState
orchestratorEnabled: boolean;
currentRound: number;
maxRounds: number;
chainStatus: "active" | "done" | "escalated" | "abandoned";
```

`currentRound`, `maxRounds`, and `chainStatus` are read-model summaries. Source of truth for replay, restart, and auditing remains the durable handoff-chain metadata on broker records.

### Loop Message Composition

When verdict is `loop`, next handoff must preserve original task truth and current review feedback together. Two loop paths exist and they are not composed the same way.

The next round should persist:

- same `chainId`
- `parentHandoffId` = handed-back handoff that was just evaluated
- incremented `roundNumber`
- unchanged `rootRequestText`

**Normal LLM-reviewed loop**

Use this when the evaluator returned `verdict === "loop"` with a usable `followUpMessage`.

The operator-visible `requestText` for the next round should be composed in this shape:

```text
Original request:
<rootRequestText>

Latest result:
<handbackText>

Follow-up:
<followUpMessage>
```

This keeps later rounds grounded in original request while still surfacing current reviewer guidance.

**Forced re-issue loop**

Use this when `captureStatus === "no_response_captured"` or `captureStatus === "no_response_captured_confidently"`. In this path the orchestrator skips the LLM entirely because there is no trustworthy new deliverable to review.

The operator-visible `requestText` for the next round should be the prior round's `requestText` re-issued unchanged. Do not synthesize a `Latest result` block with empty text, and do not require `followUpMessage`.

### Escalation Semantics

Escalation ends automatic looping. It does not require a new admin control plane.

By time orchestrator evaluates a record, explicit handback has already returned visible-session control to human baton workflow. Therefore `markEscalated(...)` should:

- mark chain as `escalated`
- persist machine-readable reason and verdict metadata
- surface escalation in `status` / `inspect`
- avoid creating any automatic next handoff
- leave collab in ordinary manual mounted-relay mode so humans can continue with normal visible-session controls if they choose

This keeps operator views read-only while avoiding a dead-end chain state.

### Failure Handling

| Failure | Behavior |
|---|---|
| LLM call fails | Retry once → if still fails → `escalate` |
| Orchestrator crashes | Broker state unchanged; human continues with normal manual baton flow |
| Collab ends mid-chain | Orphaned chain marked `abandoned` on next broker cleanup |
| Two `handed_back` events fire rapidly | Idempotency guard on persisted orchestrator status prevents duplicate evaluation for same handoff |

---

## Dynamic Role Assignment

Roles (implementer vs. reviewer) are not fixed. They are determined by the handoff task:

- If Codex sends "review specs" → Codex is implementer, Claude is reviewer
- After Claude reviews → Claude may execute the spec plan, becoming implementer

The orchestrator does not need to track fixed reviewer/implementer identities. It reads `senderAgent`/`targetAgent` from each round record and swaps them on `loop`. The LLM evaluator may infer semantic role from request content, but broker-side routing still uses explicit recorded agents.

---

## Testing Strategy

### Unit — LLM Evaluator

- Mock LLM responses, assert verdict parsing for each case
- Assert `followUpMessage` only present when `verdict === "loop"`
- Assert `escalate` forced when `roundNumber >= maxRounds` regardless of LLM output
- Assert `escalate` when `confidence < 0.5`

### Unit — Orchestrator Event Handler

- Mock broker API, feed synthetic `handed_back` events
- Assert correct broker method called per verdict
- Assert claim step happens before evaluation, and failed claim produces no side effects
- Assert sender/target swapped on `loop` handoff creation
- Assert no action when `orchestratorEnabled=false`
- Assert duplicate polling cannot reprocess already-evaluated handoff
- Assert forced re-issue loop reuses prior `requestText` unchanged when `captureStatus` is unusable
- Assert loop handoff preserves `chainId`, `parentHandoffId`, `roundNumber`, and `rootRequestText`

### Integration — Full Chain

- Spin up real broker + fake mounted sessions
- Orchestrator with mock LLM (returns controlled verdicts)
- Assert: `loop` verdict → new handoff created with correct agents/text
- Assert: `done` verdict → chain resolves, no new handoff
- Assert: escalation cap → `markEscalated` called after N rounds
- Assert: escalated chain remains visible in operator surfaces while manual relay can continue without special resume command
- Assert: collab end cleanup marks unfinished chain `abandoned`, not `done`

### Edge Cases

- LLM call fails mid-chain → `escalate` fallback fires
- Collab ends while orchestrator is evaluating → graceful no-op
- Two `handed_back` events fire rapidly → idempotency guard prevents duplicate evaluation
- `orchestratorEnabled=false` → orchestrator ignores all events for that collab
- Broker restarts mid-chain → polling resumes from durable handoff metadata without losing round identity

---

## Interaction With Mounted Relay

This spec builds on, and does not replace, mounted relay handoff behavior.

**Manual mode** (idle auto-handoff disabled explicitly by runtime configuration):
- accept / defer / decline are explicit owner actions
- handback is an explicit human action (`h` key or force `Ctrl+H`)
- orchestrator begins only after explicit `handed_back`

**Autonomous idle mode** (current default idle spec behavior; `AI_WHISPER_IDLE_THRESHOLD_MS` falls back to `30_000` when unset):
- accept fires automatically after idle threshold when handoff is pending and session is unattended
- handback fires automatically after idle threshold once accepted handoff task completes (provider goes quiet)
- orchestrator still begins only after `handed_back` — trigger source (human vs. autonomous) is transparent to the orchestrator; `captureStatus` on the handoff record distinguishes the two
- forced handback shortcuts and manual override keys remain mounted-runtime concern, not orchestrator concern

## Out of Scope

- Orchestrator accessing terminal output beyond the handoff record
- Orchestrator making decisions before `handed_back`
- Fixed role assignments (implementer/reviewer always same agent)
- Multi-collab orchestration (one orchestrator per collab session)
- Local model support (Ollama, llama3, mistral) — deferred until cloud path proven
