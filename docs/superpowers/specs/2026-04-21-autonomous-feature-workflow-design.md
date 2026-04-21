# Autonomous Feature Development Workflow — Design Spec

**Date:** 2026-04-21
**Branch:** spec/autonomous-feature-workflow
**Status:** Draft, ready for review

---

## Background

`ai-whisper` currently provides:

- Baton handoff between mounted Codex and Claude sessions with auto-accept / auto-handback on idle thresholds.
- `RelayOrchestrator` (Phase 7F): LLM-based judge that evaluates each `handed_back` handoff and emits `done | loop | escalate` to drive a single-chain review loop.

The orchestrator automates one review cycle between two agents, but a real feature-development cycle has multiple distinct cycles strung together: spec refining → plan writing → plan execution → code review. Today each transition is manual — the operator must kick off each next phase.

This spec introduces a `WorkflowDriver` component that sits above chains and advances phases autonomously, so after the operator finishes brainstorming a raw spec artifact the entire remaining cycle runs without intervention until the workflow completes or halts on escalation.

---

## Goals

- Automate the full feature-development cycle from an approved raw spec through to reviewed, tested code changes.
- Keep the existing `RelayOrchestrator` unchanged at the per-chain level; add workflow logic as a layer above chains.
- Support multiple workflow types via a registry pattern; ship one type (`superpowers-feature-development`) in v1.
- Allow agent-to-role binding to be chosen per workflow instance at kickoff.
- Persist workflow state so broker restart does not lose progress.
- Surface workflow progress in `relay-monitor` and `collab inspect`.
- Suppress all manual baton-handoff UI while a workflow owns the chain.

## Non-goals

- Changing per-chain orchestrator judgement semantics.
- Multi-collab workflow coordination.
- PR / branching / merge orchestration.
- Web UI or operator dashboard.
- Cost metering.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   broker daemon (SQLite)                 │
│                                                          │
│  ┌────────────────────────┐  ┌────────────────────────┐ │
│  │  RelayOrchestrator     │  │  WorkflowDriver  (NEW) │ │
│  │  judges one chain      │  │  advances phases       │ │
│  │  done/loop/escalate    │  │  event-driven          │ │
│  └───────────┬────────────┘  └───────────┬────────────┘ │
│              │                            │             │
│              │   BrokerEventBus (NEW, in-process)        │
│              │   chain.resolved, chain.escalated,        │
│              │   workflow.created, .phase-started,       │
│              │   .round-started, .phase-done,            │
│              │   .halted, .done                          │
│              │                            │             │
│              ▼                            ▼             │
│        broker.control API (existing + new workflow      │
│        methods)                                          │
│              │                                          │
│              ▼                                          │
│  SQLite — existing tables + new: workflows,             │
│                                  workflow_phases         │
└────────────────────────────────┬─────────────────────────┘
                                 │
                                 ▼
                  mount panes: implementer + reviewer
                  + relay-monitor pane (subscribes to bus)
```

### Invariants

- `WorkflowDriver` never calls an LLM.
- `WorkflowDriver` writes SQLite only via `broker.control` (mirrors orchestrator rule).
- One `WorkflowDriver` per broker daemon; iterates all workflows with `status='running'`.
- `RelayOrchestrator` judges only; has no knowledge of workflows beyond reading the phase's `evaluatorPromptKey` when selecting a template.
- A chain is owned by at most one workflow phase-run at a time.

---

## Data Model

### Table `workflows`

| Column | Type | Notes |
|---|---|---|
| `workflowId` | TEXT PK | `wf_<ulid>` |
| `collabId` | TEXT | FK to collab |
| `workflowType` | TEXT | e.g. `superpowers-feature-development` |
| `name` | TEXT NULL | optional user-provided; fallback display = spec slug |
| `specPath` | TEXT | workspace-relative path to raw spec artifact |
| `roleBindings` | TEXT (JSON) | e.g. `{"implementer":"claude","reviewer":"codex"}` |
| `status` | TEXT | `running` \| `done` \| `halted` |
| `currentPhaseIndex` | INT | 0-based index into phase config |
| `haltReason` | TEXT NULL | populated when `status='halted'` |
| `createdAt` | TEXT | ISO |
| `updatedAt` | TEXT | ISO |

### Table `workflow_phases`

One row per phase-attempt. A phase may have multiple rows across escalation + resume.

| Column | Type | Notes |
|---|---|---|
| `phaseRunId` | TEXT PK | `wfp_<ulid>` |
| `workflowId` | TEXT FK | |
| `phaseIndex` | INT | |
| `phaseName` | TEXT | |
| `chainId` | TEXT FK | points at RelayHandoff chain |
| `startedAt` | TEXT | |
| `endedAt` | TEXT NULL | |
| `outcome` | TEXT NULL | `done` \| `escalated` \| `superseded` |

### Existing table changes

`RelayHandoff`: `senderAgent` becomes nullable. `null` indicates a system-initiated handoff used by workflow execution phases without a human/reviewer sender.

---

## Workflow Registry

Phase definitions are TypeScript constants in code, not DB-stored in v1. The registry maps `workflowType` → full definition.

```ts
interface PhaseConfig {
  name: string;                           // "spec-refining" | ...
  implementerRole: "implementer";
  reviewerRole: "reviewer" | null;        // null ⇒ single-handoff, no review loop
  maxRounds: number;
  kickoffTemplate: string;                // placeholders: {specPath}, {planPath}
  evaluatorPromptKey: "review-loop" | "execution-gate";
  artifactOut: { kind: string; pathTemplate?: string };
}

interface WorkflowDefinition {
  type: string;
  displayName: string;
  description: string;
  phases: PhaseConfig[];
}

const WORKFLOW_REGISTRY: Record<string, WorkflowDefinition> = {
  "superpowers-feature-development": {
    type: "superpowers-feature-development",
    displayName: "Superpowers Feature Development",
    description: "Spec refining → plan writing → execution → code review",
    phases: [
      {
        name: "spec-refining",
        implementerRole: "implementer",
        reviewerRole: "reviewer",
        maxRounds: 5,
        kickoffTemplate: "Review the spec at {specPath}. Approve or list findings.",
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "spec", pathTemplate: "{specPath}" },
      },
      {
        name: "plan-writing",
        implementerRole: "implementer",
        reviewerRole: "reviewer",
        maxRounds: 5,
        kickoffTemplate:
          "Using the approved spec at {specPath}, write an implementation plan to {planPath}. When done, hand back for review.",
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "plan", pathTemplate: "{planPath}" },
      },
      {
        name: "plan-execution",
        implementerRole: "implementer",
        reviewerRole: null,
        maxRounds: 1,
        kickoffTemplate:
          "Execute the plan at {planPath} using subagents. Ensure `pnpm test` passes. Hand back with summary and test results.",
        evaluatorPromptKey: "execution-gate",
        artifactOut: { kind: "diff" },
      },
      {
        name: "code-review",
        implementerRole: "implementer",
        reviewerRole: "reviewer",
        maxRounds: 5,
        kickoffTemplate:
          "Review the diff from plan execution. Run `pnpm test`. Approve or list findings.",
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "commit" },
      },
    ],
  },
};
```

### Role bindings

Phase configs reference abstract roles (`"implementer"`, `"reviewer"`). The workflow instance's `roleBindings` JSON maps roles to concrete agent names (`"claude"` | `"codex"`). Bindings are fixed at kickoff; changing mid-workflow requires cancel + fresh start.

### Path resolution

- `{specPath}` — supplied by operator at kickoff.
- `{planPath}` — derived by driver: `docs/superpowers/plans/YYYY-MM-DD-<spec-slug>.md`, where `YYYY-MM-DD` is the workflow's `createdAt` date and `<spec-slug>` is the spec filename without the `-design` suffix and extension.

---

## BrokerEventBus

In-process `EventEmitter`, single instance owned by the broker runtime. Same-process-only; no cross-process pub/sub.

### Events

| Event | Payload |
|---|---|
| `chain.resolved` | `{ collabId, chainId }` |
| `chain.escalated` | `{ collabId, chainId, handoffId, reason }` |
| `workflow.created` | `{ workflowId }` |
| `workflow.phase-started` | `{ workflowId, phaseIndex, phaseName, chainId, implementer, reviewer }` |
| `workflow.round-started` | `{ workflowId, chainId, roundNumber, sender, target }` |
| `workflow.phase-done` | `{ workflowId, phaseIndex, phaseName }` |
| `workflow.halted` | `{ workflowId, reason }` |
| `workflow.done` | `{ workflowId }` |
| `workflow.resumed` | `{ workflowId, phaseIndex }` |

### Fire sites

- `broker.control.resolveChain` → `chain.resolved`
- `broker.control.markEscalated` → `chain.escalated`
- `broker.control.createWorkflow` → `workflow.created`
- `broker.control.createHandoff` (when handoff belongs to workflow-owned chain) → `workflow.round-started`
- `WorkflowDriver.kickoffPhase` → `workflow.phase-started`
- `WorkflowDriver.advancePhaseIfOwned` → `workflow.phase-done`, then (if another phase exists) a later `workflow.phase-started` when next kickoff fires
- `WorkflowDriver.haltWorkflowIfOwned` → `workflow.halted`
- `WorkflowDriver` on workflow completion → `workflow.done`
- `broker.control.resumeWorkflow` → `workflow.resumed`

---

## WorkflowDriver Loop

Event-driven primary path + recovery sweep secondary path.

### Subscribers

```ts
bus.on('workflow.created', (e) => kickoffPhase(e.workflowId));
bus.on('chain.resolved',   (e) => advancePhaseIfOwned(e.chainId));
bus.on('chain.escalated',  (e) => haltWorkflowIfOwned(e.chainId, e.reason));
bus.on('workflow.resumed', (e) => kickoffPhase(e.workflowId));
```

### `kickoffPhase(workflow)`

1. Read `PhaseConfig` from registry via `workflow.workflowType` + `currentPhaseIndex`.
2. Resolve template placeholders.
3. Resolve roles via `workflow.roleBindings`.
4. If target agent unbound on collab → `haltWorkflow(reason: "target agent <x> not bound")`.
5. Create handoff via `broker.control.createHandoff`:
   - `reviewer != null`: `sender = implementer`, `target = reviewer`, `requestText = resolved template`.
   - `reviewer == null`: `sender = null`, `target = implementer`, `requestText = resolved template`.
6. Insert `workflow_phases` row with new `chainId`, `startedAt = now`.
7. Update `workflows.updatedAt`.
8. Emit `workflow.phase-started`.

### `advancePhaseIfOwned(chainId)`

Only acts if the chain belongs to a workflow-owned phase run whose workflow is `status='running'`.

1. Close current `workflow_phases` row: `endedAt = now`, `outcome = 'done'`.
2. Emit `workflow.phase-done`.
3. Increment `workflows.currentPhaseIndex`.
4. If past last phase:
   - `workflows.status = 'done'`.
   - Emit `workflow.done`.
5. Else:
   - Immediately call `kickoffPhase` for the new phase.

### `haltWorkflowIfOwned(chainId, reason)`

1. If chain belongs to a workflow-owned phase run whose workflow is `status='running'`:
   - Close phase run: `endedAt = now`, `outcome = 'escalated'`.
   - `workflows.status = 'halted'`, `haltReason = reason`.
   - Emit `workflow.halted`.

### Recovery sweep

Every 30s, for each workflow with `status='running'`:

- Read latest `workflow_phases` row for `currentPhaseIndex`.
- If row's chain has `chainStatus='done'` but workflow hasn't advanced → call `advancePhaseIfOwned`.
- If row's chain has `chainStatus='escalated'` but workflow isn't halted → call `haltWorkflowIfOwned`.
- If no phase run exists for current index → call `kickoffPhase` (covers missed `workflow.created` / `workflow.resumed` event during crash).

### Concurrency

- Driver begins `BEGIN IMMEDIATE` on the workflow row before advancing. Prevents double-advance if two event handlers fire simultaneously.
- Advance is idempotent: if a row for the next `currentPhaseIndex` already exists with a live chain, skip kickoff.

---

## Broker API Additions

```ts
interface BrokerControl {
  // ... existing methods

  // Workflow lifecycle
  createWorkflow(input: {
    collabId: string;
    workflowType: string;
    name?: string;
    specPath: string;
    roleBindings: Record<string, "claude" | "codex">;
    now: string;
  }): { workflowId: string };

  resumeWorkflow(workflowId: string, now: string): void;
  cancelWorkflow(workflowId: string, now: string): void;
  getWorkflow(workflowId: string): WorkflowRecord | null;
  listWorkflows(filter?: {
    collabId?: string;
    status?: "running" | "halted" | "done";
  }): WorkflowRecord[];
  getWorkflowPhaseRuns(workflowId: string): PhaseRunRecord[];
}
```

`createHandoff` gains optional `senderAgent?: "claude" | "codex" | null`. `null` is accepted only for workflow-owned handoffs in execution phases; control service validates.

`resolveChain` and `markEscalated` signatures unchanged; they gain event-bus emissions internally.

---

## CLI Surface

```
whisper workflow start                                      # kick off a workflow
    --type <workflow-type>                                  # required
    --spec <path>                                           # required
    [--implementer claude|codex]                            # default: claude
    [--reviewer   claude|codex]                             # default: codex
    [--name <name>]                                         # optional
    [--collab <id>]                                         # default: current collab

whisper workflow list                                       # all workflows + status
whisper workflow inspect <workflow-id>                      # full phase history
whisper workflow resume <workflow-id>                       # restart halted phase with fresh chain
whisper workflow cancel <workflow-id>                       # operator halt
whisper workflow types                                      # list registered types
```

Validation:
- `--implementer` ≠ `--reviewer`.
- Both agents must be bound on the target collab.
- `--type` must exist in the registry.
- `--spec` path must exist in the workspace.

### `collab inspect` augmentation

When a workflow is active on the collab, `collab inspect` shows:

```
Chain status: active (round 2/5)
Workflow:     wf_01H... (superpowers-feature-development) "auth rewrite"
  Bindings:   implementer=claude  reviewer=codex
  Phase:      plan-writing (2/4)
```

Absent when no workflow owns the current chain.

---

## Relay-Monitor Integration

Relay-monitor runs in a **separate process** from the broker daemon (spawned as its own pane by the launcher). It cannot subscribe to `BrokerEventBus` directly. It reads workflow state via the broker control API:

- On startup: `getWorkflow(workflowId)` + `getWorkflowPhaseRuns(workflowId)` to populate header.
- Every 500ms: re-poll + diff against last snapshot. Render new rows in the event log.

`BrokerEventBus` remains in-process only; out-of-process subscribers (relay-monitor, CLI commands) rely on polling the control API.

### Header (persistent while workflow is active)

```
Workflow: wf_01H... (superpowers-feature-development) "auth rewrite"
Phase:    plan-writing (2/4)   Round: 2/5   Chain: relay_ch_...
```

When `name` is unset, display uses derived slug in brackets: `[2026-04-21-auth-rewrite]`.

### Event log additions

```
[14:05:12] ▶ phase-started   spec-refining     claude → codex        chain relay_ch_a1
[14:07:33] ↻ round-started   2/5               codex → claude        findings
[14:12:01] ✔ phase-done      spec-refining
[14:12:01] ▶ phase-started   plan-writing      claude → codex        chain relay_ch_b2
[14:18:44] ↻ round-started   2/5               codex → claude        findings
```

Icon conventions:
- `▶` phase boundary
- `↻` new review-loop round within same phase
- `✔` phase closed `done`
- `✖` phase halted (escalated)

`workflow.round-started` fires on every `createHandoff` for workflow-owned chains, including round 1. Relay-monitor suppresses the `↻` render for round 1 because `▶ phase-started` already covers it; programmatic consumers still receive the event.

---

## Evaluator Prompt Templates

Selected by `phase.evaluatorPromptKey`. Orchestrator looks up template when building LLM call. If the chain is not workflow-owned, orchestrator falls back to the existing default prompt (`review-loop`).

### `review-loop` (phases: spec-refining, plan-writing, code-review)

Reuses the current orchestrator judge prompt, extended to include phase context:

```
Phase: <phaseName>
Artifact: <resolved path>
Implementer: <agent>
Reviewer: <agent>
Round: <current> of <max>
Request (last round): <requestText>
Handback (reviewer): <handbackText>
```

Decision rules (unchanged):
- Reviewer explicitly approves → `done`
- Reviewer has findings → `loop`
- Ambiguous / empty / contradictory → `escalate`
- `roundNumber >= maxRounds` → `escalate` (forced)
- `confidence < 0.5` → `escalate`

### `execution-gate` (phase: plan-execution)

New template, no reviewer:

```
Phase: plan-execution
Artifact: <diff in workspace>
Implementer: <agent>
Handback: <agent's final message>
```

Decision rules:
- Handback contains explicit test-pass marker (regex `tests?\s+(pass|green|ok)` or embedded `pnpm test` success output) **and** non-empty diff → `done`
- Handback indicates test failure or missing test run → `escalate`
- Handback missing diff / says "no changes" → `escalate`
- LLM confidence < 0.5 → `escalate`

No `loop` verdict. Retry = operator `resume`.

### Template configuration

```ts
const EVALUATOR_TEMPLATES = {
  "review-loop": {
    systemPrompt: /* existing orchestrator prompt, adapted to include phase/artifact */,
    allowedVerdicts: ["done", "loop", "escalate"],
  },
  "execution-gate": {
    systemPrompt: /* new test-pass-aware prompt */,
    allowedVerdicts: ["done", "escalate"],
  },
};
```

---

## Kickoff / Handback / Resume / Cancel

### Kickoff flow

1. Operator brainstorms a spec (this conversation's pattern), produces `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`, commits it.
2. Operator has an active collab: `whisper collab start`.
3. Operator runs `whisper workflow start --type superpowers-feature-development --spec <path>`.
4. Broker: `createWorkflow(...)` → inserts row → emits `workflow.created`.
5. Driver handles `workflow.created` → `kickoffPhase` → creates first handoff (implementer → reviewer, "review spec at ...").
6. Relay-monitor pane renders workflow header + `▶ phase-started spec-refining`.
7. Mount panes' existing auto-accept / auto-handback carries rounds.
8. Operator walks away.

### Handback artifact contract per phase

Implementer agent must land artifacts at paths supplied in the kickoff template so downstream phases find them:

| Phase | Implementer must produce | Where |
|---|---|---|
| spec-refining | updates to `{specPath}` | in place |
| plan-writing | new file at `{planPath}` | `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |
| plan-execution | git commits | workspace |
| code-review | updates to committed code | in place |

The `kickoffTemplate` text explicitly names the artifact path so the implementing agent knows where to write.

### Resume flow

`whisper workflow resume <workflow-id>`

1. Assert `workflow.status = 'halted'`.
2. Broker: `resumeWorkflow` → sets `status = 'running'`, clears `haltReason`, emits `workflow.resumed`.
3. Driver handles `workflow.resumed` → `kickoffPhase` for current phase with fresh chain.
4. Prior escalated `workflow_phases` row preserved (outcome=`escalated`); new row inserted for the fresh attempt.

### Cancel flow

`whisper workflow cancel <workflow-id>`

1. Valid from `running` or `halted`.
2. Closes current phase run with `outcome='superseded'` (only if still open).
3. Sets workflow `status = 'halted'`, `haltReason = 'canceled by operator'`.
4. Does NOT resolve the handoff chain — operator decides manually via mount panes (which re-enable hotkeys because the chain is no longer workflow-owned).

---

## Autonomous Mode

While a handoff chain is owned by a `status='running'` workflow, mount panes operate in autonomous mode. No manual baton-handoff UI is shown and no manual keys function.

### Suppressed

- Handoff card hotkey hints (`[a]ccept [d]ecline [space]defer [h]andback`).
- Local composer fallback prompt (normally opens when clipboard capture fails).
- Force-handback hotkey (`Ctrl+H`) hint.

### Visible

- Relay-monitor header with workflow + phase + round.
- Minimal handoff status line in mount panes: `handoff pending (auto-accept in Xs)` / `working (auto-handback on idle)`.
- Escalation banner on halt: `⚠ workflow halted — resume with 'whisper workflow resume <id>'`.

### Enforcement

- Handoff card renderer checks `handoff.chain.ownedByWorkflow`. If true, render autonomous-mode variant.
- Key input handlers for `a / d / h / space / Ctrl+H` become no-ops when `ownedByWorkflow=true`. Defensive — prevents stray keypresses from interfering.
- Local composer does NOT open on capture failure for workflow-owned chains. Handback retries once; on second failure the chain escalates via existing orchestrator behavior, which triggers `workflow.halted`.

### Manual override

To intervene, operator cancels the workflow first (`whisper workflow cancel`). Cancel detaches chain from workflow ownership; hotkeys re-enable on the mount panes.

### Idle threshold guidance

Auto-accept / auto-handback thresholds must be set generously so autonomous mode does not fire prematurely. Recommended default for workflow runs: `AI_WHISPER_IDLE_THRESHOLD_MS=15000`.

---

## Testing Strategy

### Unit

**WorkflowRegistry**
- Each registered type has non-empty phases, well-formed templates, valid role assignments.
- `superpowers-feature-development` has exactly 4 phases in documented order.

**WorkflowDriver.kickoffPhase**
- Resolves `{specPath}` and `{planPath}` placeholders correctly.
- `reviewer=null` phase creates handoff with `senderAgent=null`.
- `reviewer!=null` phase creates handoff with sender=implementer, target=reviewer.
- Halts workflow if target agent unbound.

**WorkflowDriver.advancePhaseIfOwned**
- Last phase → `workflow.status='done'` and emits `workflow.done`.
- Middle phase → next phase kickoff fires and emits `workflow.phase-started`.
- Idempotent: double-advance does not create duplicate phase row.

**WorkflowDriver.haltWorkflowIfOwned**
- Sets status + reason atomically.
- Current phase row marked `escalated`.
- Emits `workflow.halted`.

**resumeWorkflow**
- Halted → running transition valid.
- Running → resume rejected.
- New phase row created; old escalated row preserved.

**BrokerEventBus**
- Each emission fires exactly once per source-method call.
- Subscribers added/removed don't affect others.

**Evaluator template selection**
- `review-loop` never emits `done` without reviewer approve signal.
- `execution-gate` never emits `loop`.
- Missing test-pass marker in execution handback → `escalate`.

**Autonomous mode**
- `ownedByWorkflow=true` hides hotkey hints in card render.
- `a / d / h / space / Ctrl+H` no-op when `ownedByWorkflow=true`.
- Local composer does not open on capture failure for workflow-owned chain.

### Integration

**Full cycle (mock LLM)**
- Seed spec file in fixture workspace.
- Start workflow → drive mock Claude / mock Codex through 4 phases.
- Assert 4 `workflow.phase-started`, 1 `workflow.done` emitted.
- Assert `workflow_phases` has 4 rows, all `outcome='done'`.
- Assert plan file created at expected path.

**Review loop within phase**
- Mock reviewer returns "findings: ..." round 1, "approve" round 2.
- Assert orchestrator emits `loop` then `done`.
- Assert driver advances phase exactly once (not twice).

**Escalation + resume**
- Force phase 2 to `maxRounds`.
- Assert `workflow.halted`, `haltReason` populated.
- `resumeWorkflow` → phase 2 restarts with new chainId.
- Assert old row `outcome='escalated'`, new row `outcome='done'`.

**Broker restart recovery**
- Kick workflow, kill broker mid-phase.
- Restart broker.
- Recovery sweep reconciles terminal chain state not yet processed.
- Assert workflow continues correctly.

**Autonomous mode enforcement**
- Simulate `a` keypress on mount pane while workflow-owned chain is pending.
- Assert key ignored, handoff state unchanged.

### Manual smoke test

Lives at `docs/smoke-tests/superpowers-workflow-smoke-test.md`.

1. Brainstorm a tiny spec (e.g. "add CLI command that prints 'hello'").
2. Commit spec file.
3. `whisper collab start` + `whisper workflow start --type superpowers-feature-development --spec <path>`.
4. Walk away ~10 min.
5. Verify: workflow reaches `done`, plan file exists, code committed, `pnpm test` green.
6. Repeat with intentionally ambiguous spec to force escalation.

---

## Out of Scope (v1)

- Multiple concurrent workflows per collab — one at a time.
- Workflow editing at runtime (insert/skip/reorder phases).
- Workflow types beyond `superpowers-feature-development`.
- Swapping role bindings mid-workflow (requires cancel + restart).
- Git branching, PR creation, merge orchestration.
- Web UI / dashboard.
- Per-workflow phase customization stored in DB (registry stays code-only in v1).
- Artifact content validation (schema checks on spec/plan markdown).
- Cost metering / API budget guards per workflow.
- Cross-collab workflow coordination.
- Migrating `RelayOrchestrator` from polling to event-driven (orthogonal).
