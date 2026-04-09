# Relay Orchestrator Agent — Design Spec

**Date:** 2026-04-09
**Branch:** feat/turn-owned-mounted-relay-handoff
**Status:** Approved, ready for implementation planning

---

## Background

Current baton handoff workflow requires human operator to press hotkeys (a/d/e/space/h) to accept, defer, decline, amend, or hand back the turn. This is intentional for human-in-the-loop control but creates friction for automated or high-trust collab sessions.

This spec introduces a `RelayOrchestrator` daemon that replaces the hotkey-driven loop with an LLM-based evaluator. The orchestrator reads handoff records after each `handed_back` event, determines whether the deliverable satisfies the request, and either closes the chain, triggers another loop, or escalates to a human operator.

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
   broker.createHandoff()   broker.markEscalated()
   (auto-send baton back)   (surface to human operator)
```

**Key invariants:**
- Broker never calls LLM — stays pure state machine
- Orchestrator never writes SQLite directly — always via broker API
- Loop counter tracked per handoff chain (not per session)
- Escalation cap: configurable `maxRounds` (default 3)
- `orchestratorEnabled` is opt-in per collab — existing collabs unaffected

---

## LLM Evaluator Contract

### Input

The orchestrator passes the handoff record to the LLM evaluator:

```ts
interface EvaluatorInput {
  requestText: string;     // what was asked (existing field: RelayHandoff.requestText)
  handbackText: string;    // captured assistant turn at handback (maps to the latest-turn capture introduced in the handback flow — implementation must confirm exact field name)
  senderAgent: string;     // who sent the baton
  targetAgent: string;     // who did the work
  roundNumber: number;     // current loop iteration (1-based)
  maxRounds: number;       // escalation cap
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

### Decision Rules (baked into prompt)

| Condition | Verdict |
|---|---|
| Reviewer explicitly approves, or response fully satisfies request | `done` |
| Reviewer has findings, implementer needs another pass | `loop` |
| `roundNumber >= maxRounds` | `escalate` (forced, overrides LLM) |
| Ambiguous or contradictory response | `escalate` |
| `confidence < 0.5` | `escalate` |
| LLM call fails after 1 retry | `escalate` (safe default) |

---

## Orchestrator Lifecycle

### Startup

Orchestrator starts alongside the relay, launched by broker daemon or `collab start` when `orchestratorEnabled=true` for the collab. Subscribes to broker handoff events on init via **polling** (broker is SQLite-backed, no native event emitter). Orchestrator polls for new `handed_back` handoffs at a configurable interval (default 1s), using last-seen handoff ID as cursor to avoid reprocessing.

### Per-Event Flow

```
handed_back event received
  → look up handoff record
  → check: orchestratorEnabled for this collab?
  → call LLM evaluator (async, non-blocking to broker)
  → on verdict:
       done      → broker.resolveChain(collabId)
       loop      → broker.createHandoff(sender↔target swapped, followUpMessage)
       escalate  → broker.markEscalated(handoffId, reason)
```

### New Broker API Methods

These methods do not exist today and must be added to the broker:

- `broker.resolveChain(collabId)` — marks chain as `done`, no further orchestrator action
- `broker.markEscalated(handoffId, reason)` — sets `chainStatus="escalated"`, surfaces to operator view

### New Broker State Fields

```ts
// Added to RelayTurnState
orchestratorEnabled: boolean;
currentRound: number;
maxRounds: number;
chainStatus: "active" | "done" | "escalated";
```

### Failure Handling

| Failure | Behavior |
|---|---|
| LLM call fails | Retry once → if still fails → `escalate` |
| Orchestrator crashes | Broker state unchanged; human resumes manually |
| Collab ends mid-chain | Orphaned chain marked `done` on next broker cleanup |
| Two `handed_back` events fire rapidly | Idempotency guard — ignore duplicate for same handoff ID |

---

## Dynamic Role Assignment

Roles (implementer vs. reviewer) are not fixed. They are determined by the handoff task:

- If Codex sends "review specs" → Codex is implementer, Claude is reviewer
- After Claude reviews → Claude may execute the spec plan, becoming implementer

The orchestrator does not need to track roles explicitly. It reads `senderAgent`/`targetAgent` from the handoff record and swaps them on `loop`. The LLM evaluator infers roles from `requestText` content.

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
- Assert sender/target swapped on `loop` handoff creation
- Assert no action when `orchestratorEnabled=false`

### Integration — Full Chain

- Spin up real broker + fake mounted sessions
- Orchestrator with mock LLM (returns controlled verdicts)
- Assert: `loop` verdict → new handoff created with correct agents/text
- Assert: `done` verdict → chain resolves, no new handoff
- Assert: escalation cap → `markEscalated` called after N rounds

### Edge Cases

- LLM call fails mid-chain → `escalate` fallback fires
- Collab ends while orchestrator is evaluating → graceful no-op
- Two `handed_back` events fire rapidly → idempotency guard prevents duplicate evaluation
- `orchestratorEnabled=false` → orchestrator ignores all events for that collab

---

## Out of Scope

- Orchestrator accessing terminal output beyond the handoff record
- Orchestrator making decisions before `handed_back` (e.g., auto-accept)
- Fixed role assignments (implementer/reviewer always same agent)
- Multi-collab orchestration (one orchestrator per collab session)
- Local model support (Ollama, llama3, mistral) — deferred until cloud path proven
