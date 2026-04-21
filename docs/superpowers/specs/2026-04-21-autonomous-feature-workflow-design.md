# Autonomous Feature Development Workflow — Design Spec

**Date:** 2026-04-21
**Branch:** spec/autonomous-feature-workflow
**Status:** Draft, revised after first review

---

## Background

`ai-whisper` currently provides:

- Baton handoff between mounted Codex and Claude sessions with auto-accept / auto-handback on idle thresholds.
- `RelayOrchestrator` (Phase 7F): LLM-based judge that evaluates each `handed_back` handoff and emits `done | loop | escalate` to drive a single-chain review loop.

The orchestrator automates one review cycle between two agents. A real feature-development cycle has multiple distinct cycles strung together: spec refining → plan writing → plan execution → code review. Each transition is manual today.

This spec introduces a `WorkflowDriver` component that sits above chains and advances phases autonomously. After the operator finishes brainstorming a raw spec artifact, the remaining cycle runs without intervention until the workflow completes or halts on escalation.

---

## Goals

- Automate the full feature-development cycle from an approved raw spec through to reviewed, tested code changes.
- Keep `RelayOrchestrator` responsible only for per-chain judgment; extend its evaluator input/config to be workflow-aware.
- Support multiple workflow types via a registry pattern; ship one type (`superpowers-feature-development`) in v1.
- Allow agent-to-role binding per workflow instance at kickoff.
- Persist workflow state and per-chain terminal state so broker restart does not lose progress.
- Surface workflow progress in `relay-monitor` and `collab inspect`.
- Suppress all manual baton-handoff UI while a workflow owns the chain.

## Non-goals

- Multi-collab workflow coordination.
- PR / branching / merge orchestration.
- Web UI or operator dashboard.
- Cost metering.
- Changing verdict vocabulary for **legacy (non-workflow) chains** — they continue to use `done | loop | escalate`. Workflow-owned chains use a new structured step vocabulary (`approve | findings | delivered | execution-pass | execution-fail | escalate`); see "RelayOrchestrator Contract".

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   broker daemon (SQLite)                 │
│                                                          │
│  ┌────────────────────────┐  ┌────────────────────────┐ │
│  │  RelayOrchestrator     │  │  WorkflowDriver  (NEW) │ │
│  │  per-chain judge       │  │  advances phases       │ │
│  │  workflow-aware config │  │  event-driven          │ │
│  │  emits verdict+next    │  └──────────┬─────────────┘ │
│  └───────────┬────────────┘             │               │
│              │                           │               │
│              │  BrokerEventBus (in-process only)         │
│              │  chain.resolved, chain.escalated,         │
│              │  workflow.* family                        │
│              │                           │               │
│              ▼                           ▼               │
│        broker.control API                                │
│              │                                          │
│              ▼                                          │
│  SQLite — existing tables + new: workflows,             │
│           workflow_phases, relay_chains;                │
│           extended: relay_handoff (handoffStep, ...)    │
└────────────────────────────────┬─────────────────────────┘
                                 │ broker.control
                                 ▼
          ┌──────────────────────┴──────────────────────┐
          │                                              │
     mount panes                                  relay-monitor
     (implementer,                                (separate process,
     reviewer)                                    polls control API)
```

### Invariants

- `WorkflowDriver` never calls an LLM.
- `WorkflowDriver` writes SQLite only via `broker.control`.
- `RelayOrchestrator` never writes SQLite directly; emits a verdict which the broker translates into state changes.
- `BrokerEventBus` is in-process; all out-of-process observers (relay-monitor, CLI) rely on polling the control API.
- A chain is owned by at most one workflow phase-run at a time. Ownership is durable (stored in `workflow_phases.chainId`).
- At most one workflow per collab may have `status='running'` at any time.
- A workflow phase-run cannot begin without a durable `relay_chains` row tied to its handoff.

---

## Data Model

### New table `workflows`

| Column | Type | Notes |
|---|---|---|
| `workflowId` | TEXT PK | `wf_<ulid>` |
| `collabId` | TEXT | FK to collab |
| `workflowType` | TEXT | e.g. `superpowers-feature-development` |
| `name` | TEXT NULL | optional; display fallback = spec slug |
| `specPath` | TEXT | workspace-relative path to raw spec artifact |
| `roleBindings` | TEXT (JSON) | `{"implementer":"claude","reviewer":"codex"}` |
| `status` | TEXT | `running` \| `done` \| `halted` \| `canceled` |
| `currentPhaseIndex` | INT | 0-based index into phase config |
| `haltReason` | TEXT NULL | populated when `status IN ('halted','canceled')` |
| `workflow_context` | TEXT (JSON) | carry-forward outputs across phases (see "Workflow context shape" below); default `'{}'` |
| `createdAt` | TEXT | ISO |
| `updatedAt` | TEXT | ISO |

**Constraint:** partial unique index enforces at most one running workflow per collab:
```sql
CREATE UNIQUE INDEX workflows_one_running_per_collab
  ON workflows(collabId) WHERE status = 'running';
```

**Workflow context shape** — the JSON blob in `workflow_context` is written only by `applyOrchestratorVerdict` (see broker API). Known keys:

```jsonc
{
  "baseBeforeExecution": "<sha>",      // captured when plan-execution phase starts
  "headAfterExecution":  "<sha>",      // captured when plan-execution ends
  "commitRange":         "<base>..<head>",   // git-valid range (excludes base, includes head)
  "executionCommitShas": ["<sha>", ...],     // parsed from execute handback
  "codeReviewFixShas":   ["<sha>", ...]      // additional SHAs from code-review fix-delivered rounds
}
```

The range `<base>..<head>` is used as-is wherever `{commitRange}` appears in templates. On each code-review `fix + delivered`, broker re-reads HEAD, appends new SHAs to `codeReviewFixShas`, advances `headAfterExecution` to the new HEAD, and recomputes `commitRange = baseBeforeExecution..headAfterExecution`. The range is always cumulative — the reviewer sees the full feature branch on recheck so fix commits are verified in context. The commit-list keys are informational for audit; templates read only `commitRange`.

### New table `workflow_phases`

One row per phase-attempt. A phase may have multiple rows across escalation + resume.

| Column | Type | Notes |
|---|---|---|
| `phaseRunId` | TEXT PK | `wfp_<ulid>` |
| `workflowId` | TEXT FK | |
| `phaseIndex` | INT | |
| `phaseName` | TEXT | |
| `chainId` | TEXT FK | points at `relay_chains.chainId` |
| `startedAt` | TEXT | |
| `endedAt` | TEXT NULL | |
| `outcome` | TEXT NULL | `done` \| `escalated` \| `superseded` |

### New table `relay_chains`

Durable per-chain terminal state, previously conflated with collab-level relay turn state.

| Column | Type | Notes |
|---|---|---|
| `chainId` | TEXT PK | `relay_ch_<ulid>` |
| `collabId` | TEXT FK | |
| `status` | TEXT | `active` \| `done` \| `escalated` \| `abandoned` |
| `currentRound` | INT | |
| `maxRounds` | INT | from phase config (or legacy default for non-workflow chains) |
| `terminalHandoffId` | TEXT NULL | the handoff that produced the terminal verdict |
| `terminalReason` | TEXT NULL | free-text reason at escalation/abandonment |
| `createdAt` | TEXT | |
| `updatedAt` | TEXT | |

Populated by broker whenever a chain is created (workflow-owned or legacy). `broker.control.getRelayChain(chainId)` returns this record.

### Extended table `relay_handoff`

New columns (additive, nullable for legacy rows):

| Column | Type | Notes |
|---|---|---|
| `handoffStep` | TEXT NULL | one of `review` \| `fix` \| `implement` \| `execute` \| `null` (legacy) |
| `workflowId` | TEXT FK NULL | set when handoff belongs to workflow-owned chain |
| `phaseRunId` | TEXT FK NULL | set when handoff belongs to workflow-owned chain |
| `evaluatorVerdict` | TEXT NULL | orchestrator verdict applied to this handoff; workflow chains use structured vocabulary, legacy chains store `done \| loop \| escalate` |
| `evaluatorConfidence` | REAL NULL | 0.0–1.0 |
| `evaluatorReason` | TEXT NULL | free-text; also carries normalization reason (`"max-rounds-reached"`, `"low-confidence: ..."`, `"illegal-step-verdict: ..."`) when applicable |
| `evaluatorEvaluatedAt` | TEXT NULL | ISO timestamp |

`senderAgent` remains non-nullable. System-initiated execution handoffs use the reviewer-bound agent as nominal sender (see "Execution phase sender" below).

> Orchestrator bookkeeping lives on `relay_handoff` — no separate audit table. This matches the existing Phase 7F implementation.

---

## Workflow Registry

Phase definitions are TypeScript constants; not DB-stored in v1.

```ts
type HandoffStep = "review" | "fix" | "implement" | "execute";

interface PhaseConfig {
  name: string;
  implementerRole: "implementer";
  reviewerRole: "reviewer" | null;         // null ⇒ single-handoff, execution-gate
  maxRounds: number;                        // counts "review" steps (or "execute")
  initialHandoffStep: HandoffStep;
  kickoffTemplate: string;                  // placeholders: {specPath}, {planPath}
  stepTemplates: Partial<Record<HandoffStep, string>>;  // per-step request text
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
        initialHandoffStep: "review",
        kickoffTemplate: "Review the spec at {specPath}. Approve or list findings.",
        stepTemplates: {
          review: "Review the spec at {specPath}. Approve or list findings.",
          fix: "Address the reviewer's findings in {specPath}:\n{lastFindings}",
        },
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "spec", pathTemplate: "{specPath}" },
      },
      {
        name: "plan-writing",
        implementerRole: "implementer",
        reviewerRole: "reviewer",
        maxRounds: 5,
        initialHandoffStep: "implement",
        kickoffTemplate:
          "Using the approved spec at {specPath}, write an implementation plan to {planPath}. Hand back when the file is ready.",
        stepTemplates: {
          implement:
            "Using the approved spec at {specPath}, write an implementation plan to {planPath}. Hand back when the file is ready.",
          review: "Review the implementation plan at {planPath}. Approve or list findings.",
          fix: "Address the reviewer's findings in {planPath}:\n{lastFindings}",
        },
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "plan", pathTemplate: "{planPath}" },
      },
      {
        name: "plan-execution",
        implementerRole: "implementer",
        reviewerRole: null,
        maxRounds: 1,
        initialHandoffStep: "execute",
        kickoffTemplate:
          "Execute the plan at {planPath} using subagents. Ensure `pnpm test` passes. Commit changes. Hand back with commit SHAs and test results.",
        stepTemplates: {
          execute:
            "Execute the plan at {planPath} using subagents. Ensure `pnpm test` passes. Commit changes. Hand back with commit SHAs and test results.",
        },
        evaluatorPromptKey: "execution-gate",
        artifactOut: { kind: "commit-range" },
      },
      {
        name: "code-review",
        implementerRole: "implementer",
        reviewerRole: "reviewer",
        maxRounds: 5,
        initialHandoffStep: "review",
        kickoffTemplate:
          "Review commits {commitRange}. Run `pnpm test`. Approve or list findings.",
        stepTemplates: {
          review:
            "Review commits {commitRange}. Run `pnpm test`. Approve or list findings.",
          fix: "Address the reviewer's findings on commits {commitRange}:\n{lastFindings}",
        },
        evaluatorPromptKey: "review-loop",
        artifactOut: { kind: "commit-range" },
      },
    ],
  },
};
```

### Role bindings

Phase configs reference abstract roles (`"implementer"`, `"reviewer"`). Workflow instance `roleBindings` JSON maps roles to concrete agent names. Fixed at kickoff; changing mid-workflow requires cancel + fresh start.

### Path resolution

- `{specPath}` — supplied at kickoff.
- `{planPath}` — derived by driver: `docs/superpowers/plans/YYYY-MM-DD-<spec-slug>.md`; `YYYY-MM-DD` = workflow `createdAt` date; slug = spec filename without `-design` suffix and extension.
- `{commitRange}` — read from `workflow_context.commitRange`. Populated by broker when the plan-execution chain resolves (captures base-before-execution + head-after-execution). Re-computed on each code-review `fix + delivered` so recheck rounds cover the updated range. Format is always `<base>..<head>` (git-valid: excludes base, includes head).
- `{lastFindings}` — the text of the most recent reviewer handback that requested changes.

---

## Handoff Step Choreography

Every workflow-owned handoff carries a `handoffStep`. Steps model the review-loop precisely:

| Step | Sender | Target | Semantic |
|---|---|---|---|
| `review` | implementer | reviewer | reviewer evaluates artifact; may approve or list findings |
| `fix` | reviewer | implementer | implementer addresses findings; produces an updated artifact |
| `implement` | reviewer | implementer | implementer authors an artifact from scratch (first pass of plan-writing) |
| `execute` | reviewer | implementer | implementer runs the plan end-to-end (single shot) |

### Step transition table (per verdict)

Orchestrator emits a structured verdict. Driver (via broker) applies the transition:

| Current step | Verdict from orchestrator | Next action |
|---|---|---|
| `review` | `approve` | resolve chain `done` |
| `review` | `findings` | create next handoff, step=`fix` |
| `review` | `escalate` | mark chain `escalated` |
| `fix` | `delivered` | create next handoff, step=`review` |
| `fix` | `escalate` | mark chain `escalated` |
| `implement` | `delivered` | create next handoff, step=`review` |
| `implement` | `escalate` | mark chain `escalated` |
| `execute` | `execution-pass` | resolve chain `done` |
| `execute` | `execution-fail` | mark chain `escalated` |

**Round counting:** `currentRound` in `relay_chains` starts at 1 when the phase's initial handoff is created. Subsequent `review`, `implement`, or `execute` step handoffs increment `currentRound`. `fix` steps do NOT increment. (Under the current registry, only `review` steps occur after round 1 for review-loop phases; `implement`/`execute` steps only occur as round-1 initial handoffs.)

**maxRounds enforcement:** the check fires at exactly one decision point — when `applyOrchestratorVerdict` is about to create the next `review` handoff after a `review + findings → fix + delivered` cycle.
- If `currentRound + 1 > maxRounds` at that point → the verdict is forced to `escalate` before any new handoff is created.
- For phases with `reviewerRole=null` (execution-gate), `maxRounds=1` enforces single-shot execution: there is no `review` step and therefore no second round — the comparison is effectively a no-op but the value must still be 1 for schema sanity.
- For review-loop phases, `maxRounds` counts the maximum number of `review` handoffs (including the initial one at round 1).

---

## RelayOrchestrator Contract (workflow-aware)

The orchestrator remains the per-chain judge. Its contract is now:

### Input (per handback event)

Orchestrator reads workflow-aware metadata from the handoff + linked workflow records:

```ts
interface EvaluatorInput {
  handoffId: string;
  chainId: string;
  workflowId: string | null;
  phaseRunId: string | null;
  phaseName: string | null;
  handoffStep: HandoffStep | null;
  evaluatorPromptKey: "review-loop" | "execution-gate" | "legacy";
  implementerAgent: string;
  reviewerAgent: string | null;
  artifactKind: string | null;
  artifactPath: string | null;
  currentRound: number;
  maxRounds: number;
  requestText: string;
  handbackText: string;
  lastHandbackSender: "implementer" | "reviewer";
}
```

For legacy chains (no workflow), `workflowId`/`phaseRunId` are null and `evaluatorPromptKey='legacy'` preserves pre-workflow judge behavior.

### Output

```ts
interface EvaluatorVerdict {
  verdict:
    | "approve"          // review step, reviewer approves
    | "findings"         // review step, reviewer has findings
    | "delivered"        // fix/implement step, implementer produced work
    | "execution-pass"   // execute step, gate satisfied
    | "execution-fail"   // execute step, gate failed
    | "escalate";        // any step, unrecoverable
  confidence: number;    // 0.0–1.0
  reason: string;
  followUpMessage?: string;  // used to build next handoff requestText
}
```

### Guardrails

- `done` outcome only derives from `verdict='approve'` (review-loop) or `verdict='execution-pass'` (execution-gate). `delivered` never closes the chain.
- `confidence < 0.5` forces `escalate` regardless of verdict.
- On `review + findings`: if `currentRound + 1 > maxRounds`, the verdict is forced to `escalate` before any new handoff is created. (Applied inside `applyOrchestratorVerdict`; see "Atomic semantics".)
- Verdict set must match phase's `allowedVerdicts` (derived from `evaluatorPromptKey`); mismatch forces `escalate`.
- Orchestrator logs every verdict for audit. Bookkeeping columns are added to `relay_handoff` (`evaluatorVerdict`, `evaluatorConfidence`, `evaluatorReason`, `evaluatorEvaluatedAt`); terminal chain details remain on `relay_chains` (`terminalHandoffId`, `terminalReason`). No separate evaluator-log table.

Legacy chains: orchestrator falls back to the existing `done | loop | escalate` vocabulary.

---

## BrokerEventBus

In-process `EventEmitter`, single instance owned by the broker runtime. Same-process only.

### Events

| Event | Payload |
|---|---|
| `chain.resolved` | `{ collabId, chainId }` |
| `chain.escalated` | `{ collabId, chainId, handoffId, reason }` |
| `workflow.created` | `{ workflowId }` |
| `workflow.phase-started` | `{ workflowId, phaseIndex, phaseName, chainId, phaseRunId, implementer, reviewer }` |
| `workflow.round-started` | `{ workflowId, chainId, phaseRunId, roundNumber, handoffStep, sender, target }` |
| `workflow.phase-done` | `{ workflowId, phaseIndex, phaseName }` |
| `workflow.halted` | `{ workflowId, reason }` |
| `workflow.canceled` | `{ workflowId, reason }` |
| `workflow.done` | `{ workflowId }` |
| `workflow.resumed` | `{ workflowId, phaseIndex }` |

### Emission ownership rule

**All durable-state events are emitted by broker methods after their transaction commits.** `WorkflowDriver` never emits events directly. This prevents double-emission and guarantees no event fires for a state change that was rolled back.

### Fire sites (single owner per event)

| Event | Owning broker method | Notes |
|---|---|---|
| `workflow.created` | `createWorkflow` | |
| `workflow.phase-started` | `beginPhaseRun` | fires with sibling `workflow.round-started` for round 1 |
| `workflow.round-started` | `beginPhaseRun` (round 1) **or** `applyOrchestratorVerdict` (round 2+) | not emitted by `createHandoff`; workflow-owned continuations route through `applyOrchestratorVerdict` |
| `workflow.phase-done` | `applyOrchestratorVerdict` | only when verdict closes the chain |
| `workflow.halted` | `applyOrchestratorVerdict` | fires with sibling `workflow.phase-done` (outcome=escalated) |
| `workflow.done` | `applyOrchestratorVerdict` | fires after the last phase's `phase-done`; no `phase-started` follows |
| `workflow.resumed` | `resumeWorkflow` | driver reacts by calling `beginPhaseRun` |
| `workflow.canceled` | `cancelWorkflow` | |
| `chain.resolved` | `applyOrchestratorVerdict` (workflow-owned) **or** `resolveChain` (legacy) | |
| `chain.escalated` | `applyOrchestratorVerdict` (workflow-owned) **or** `markEscalated` (legacy) | |

Relay-monitor suppresses the `↻` render for round 1 because `▶ phase-started` already covers it; programmatic consumers still receive the event.

---

## WorkflowDriver Loop

With `applyOrchestratorVerdict` doing all per-verdict state transitions atomically (see broker API), the driver's remaining responsibilities are narrow: kick off the first phase, react to resume, and run a crash-recovery sweep.

### Subscribers

```ts
bus.on('workflow.created', (e) => kickoffCurrentPhase(e.workflowId));
bus.on('workflow.resumed', (e) => kickoffCurrentPhase(e.workflowId));
```

The driver does NOT subscribe to `chain.resolved` or `chain.escalated` — those are handled inside `applyOrchestratorVerdict`, which already advances the phase or halts the workflow in the same transaction.

### `kickoffCurrentPhase(workflowId)`

1. Load workflow. If `status !== 'running'` → skip (no-op, guards against racey double-fire).
2. Read `PhaseConfig` from registry via `workflowType` + `currentPhaseIndex`.
3. Resolve template placeholders (including `{commitRange}` from `workflow_context` for code-review) and role bindings.
4. Assert both bound agents are present on the collab. If not → call `broker.control.haltWorkflow(workflowId, reason: "target agent <x> not bound")` (which emits `workflow.halted`).
5. **If this is the plan-execution phase:** read current workspace HEAD via `git rev-parse HEAD` in `collab.workspaceRoot` and pass it as `executionBaseHeadSha` to `beginPhaseRun`. If the git read fails → halt workflow with reason `"failed to read workspace HEAD for plan-execution: <error>"`.
6. Call `broker.control.beginPhaseRun({ workflowId, phaseIndex, phaseName, initialHandoffStep, kickoffText, sender, target, maxRounds, executionBaseHeadSha?, now })`. Broker in one transaction:
   - Validates workflow state.
   - If `initialHandoffStep='execute'` and `executionBaseHeadSha` is missing, rejects with `"beginPhaseRun(execute) requires executionBaseHeadSha"`.
   - If `executionBaseHeadSha` is provided, writes it to `workflow_context.baseBeforeExecution`.
   - Inserts `relay_chains`, `workflow_phases`, and the round-1 `relay_handoff`.
   - Updates `workflows.updatedAt`.
   - Emits `workflow.phase-started` + `workflow.round-started` post-commit.

The driver itself emits no events.

> There is no separate `captureExecutionBase` method; folding the base-SHA capture into `beginPhaseRun` keeps it inside the same transaction as the rest of the phase-run insert, and guarantees every plan-execution start — whether triggered externally by the driver (phase index 0 / resume) or internally by `applyOrchestratorVerdict` (phase advance) — captures the base SHA atomically.

### Recovery sweep

Because all per-verdict state transitions (chain + phase-run + workflow status + next-phase kickoff) happen inside a single `applyOrchestratorVerdict` transaction, SQLite state is always internally consistent after crash. The sweep only has to catch **missed kickoff events** (`workflow.created` / `workflow.resumed` dropped across a broker restart).

Every 30s, for each workflow with `status='running'`:

- Read latest `workflow_phases` row for `currentPhaseIndex`.
- If no phase run exists for current index → call `kickoffCurrentPhase` (covers missed `workflow.created` / `workflow.resumed` during crash).
- Otherwise: no action. Active chains naturally resume via the orchestrator polling loop; terminal chains already wrote their advance/halt effects in the same txn.

### Concurrency

- All state transitions live inside broker methods wrapped in `BEGIN IMMEDIATE`. The driver holds no locks.
- `kickoffCurrentPhase` is idempotent: `beginPhaseRun` rejects if an open phase run for `currentPhaseIndex` already exists.
- `applyOrchestratorVerdict` is idempotent on `handoffId` (see below).

### Execution phase sender

Execution handoffs use the **reviewer-bound agent as nominal sender** (sender=reviewerAgent, target=implementerAgent). Rationale: the existing relay state machine (waiting agent, handback routing, turn ownership) assumes a concrete sender. Using the reviewer-agent as sender preserves all invariants:
- On execution handback (implementer→reviewer), existing handback routing works unchanged.
- Mount panes render the handoff normally; autonomous mode suppresses hotkeys.
- Orchestrator picks `execution-gate` template based on `handoffStep='execute'`.

Reviewer's mount pane displays the handback but takes no action; auto-handback mechanics are not relevant because execution is single-shot (no `fix` follow-up).

---

## Broker API Additions

```ts
interface BrokerControl {
  // Chain terminal state
  getRelayChain(chainId: string): RelayChainRecord | null;

  // Workflow-aware handoff creation (atomic phase-run + chain + handoff).
  // For plan-execution phase starts (initialHandoffStep='execute'),
  // executionBaseHeadSha is required and is written to
  // workflow_context.baseBeforeExecution in the same transaction.
  beginPhaseRun(input: {
    workflowId: string;
    phaseIndex: number;
    phaseName: string;
    initialHandoffStep: HandoffStep;
    kickoffText: string;
    sender: "claude" | "codex";
    target: "claude" | "codex";
    maxRounds: number;
    executionBaseHeadSha?: string;  // required when initialHandoffStep='execute'
    now: string;
  }): { phaseRunId: string; chainId: string; handoffId: string };

  // Single atomic state-transition method for workflow-owned chains.
  // Orchestrator calls this (not createHandoff / resolveChain / markEscalated
  // directly) after emitting a verdict. All per-verdict effects happen here.
  applyOrchestratorVerdict(input: {
    handoffId: string;              // the handoff being evaluated
    verdict:
      | "approve"
      | "findings"
      | "delivered"
      | "execution-pass"
      | "execution-fail"
      | "escalate";
    confidence: number;             // 0.0–1.0
    reason: string;
    followUpMessage?: string;       // used to build next handoff requestText
    extractedCommitShas?: string[]; // provided by orchestrator for execute-pass + code-review fix-delivered
    workspaceHeadSha?: string;      // required when the verdict may advance into plan-execution;
                                    // the orchestrator reads HEAD before calling
    now: string;
  }): {
    action:
      | "chain-continued"           // next fix/review handoff created
      | "phase-advanced"            // chain resolved done, next phase kicked off
      | "workflow-done"             // chain resolved done, last phase complete
      | "workflow-halted"           // chain escalated, workflow halted
      | "noop-already-applied";     // idempotency hit
    chainId: string;
    nextHandoffId?: string;
    nextPhaseRunId?: string;
  };

  // Standard handoff gains workflowOwner metadata.
  // NOTE: for workflow-owned chains, round-2+ handoffs are created by
  // applyOrchestratorVerdict, not by external callers. This method is public
  // for legacy chains and for the orchestrator's internal use.
  createHandoff(input: {
    collabId: string;
    sender: "claude" | "codex";
    target: "claude" | "codex";
    requestText: string;
    now: string;
    workflowOwner?: {
      workflowId: string;
      phaseRunId: string;
      handoffStep: HandoffStep;
    };
    chainId?: string;       // reuse for loop continuations within same chain
    roundNumber?: number;
  }): { handoffId: string; chainId: string };

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
  haltWorkflow(workflowId: string, reason: string, now: string): void;

  getWorkflow(workflowId: string): WorkflowRecord | null;
  listWorkflows(filter?: {
    collabId?: string;
    status?: "running" | "halted" | "done" | "canceled";
  }): WorkflowRecord[];
  getWorkflowPhaseRuns(workflowId: string): PhaseRunRecord[];
}
```

### `applyOrchestratorVerdict` — atomic semantics

Wrapped in `BEGIN IMMEDIATE`. Idempotent on `handoffId` (second call returns `action: "noop-already-applied"`).

Within the transaction:

1. **Load + normalize.** Read the handoff, its chain, phase-run, and workflow. Hard rejections (throw; caller is buggy, not recoverable): handoff not workflow-owned, workflow not `status='running'`, chain not `active`. **Soft normalizations (rewrite the verdict before applying):** if `handoffStep` + `verdict` pair is illegal per the step-transition table → rewrite to `verdict='escalate'` with `reason='illegal-step-verdict: <original>'`. If `confidence < 0.5` → rewrite to `verdict='escalate'` with `reason='low-confidence: <original-reason>'`. On `review + findings`, if `currentRound + 1 > maxRounds` → rewrite to `verdict='escalate'` with `reason='max-rounds-reached (<n>/<max>)'`. After normalization, step 3 always sees a legal step/verdict pair.
2. **Record evaluator bookkeeping on `relay_handoff`.** The existing orchestrator writes its bookkeeping to `relay_handoff`; this spec extends it with three additive, nullable columns: `evaluatorVerdict TEXT`, `evaluatorConfidence REAL`, `evaluatorReason TEXT`, plus `evaluatorEvaluatedAt TEXT`. Legacy `done | loop | escalate` values remain valid for non-workflow rows. No new audit table is introduced. Terminal chain details (which handoff closed the chain and why) continue to live on `relay_chains.terminalHandoffId` / `terminalReason`.
3. **Apply per-verdict state change:**
   - `approve` (review step): set `relay_chains.status='done'`, `terminalHandoffId=handoffId`. Close `workflow_phases` row (`outcome='done'`). Advance: if last phase → set `workflows.status='done'`; else increment `currentPhaseIndex`, call internal `kickoffNextPhase` (composes the same insert logic as `beginPhaseRun`, in this transaction). If the next phase's `initialHandoffStep='execute'`, the broker uses `input.workspaceHeadSha` to populate `workflow_context.baseBeforeExecution` atomically. If `workspaceHeadSha` is missing on a transition that requires it, the transaction aborts with `"applyOrchestratorVerdict: workspaceHeadSha required for advance into plan-execution"` and no state changes. Orchestrator policy: always read HEAD before calling `applyOrchestratorVerdict` on plan-writing review handoffs.
   - `findings` (review step): compute `nextRound = currentRound + 1`; if `nextRound > maxRounds` → treat as `escalate` (see below). Else insert new `relay_handoff` with `handoffStep='fix'`, `senderAgent=reviewer`, `targetAgent=implementer`, `requestText` built from `followUpMessage`. Do NOT increment `currentRound` (fix steps don't count).
   - `delivered` (fix step): insert new `relay_handoff` with `handoffStep='review'`, `senderAgent=implementer`, `targetAgent=reviewer`. Increment `currentRound`. **Code-review special case:** if phase is `code-review`, also append `input.extractedCommitShas` to `workflow_context.codeReviewFixShas`, set `headAfterExecution` to the latest SHA, recompute `commitRange = baseBeforeExecution..headAfterExecution`. The rebuilt `requestText` uses the updated `commitRange`.
   - `delivered` (implement step): insert new `relay_handoff` with `handoffStep='review'`, `senderAgent=implementer`, `targetAgent=reviewer`. Increment `currentRound`.
   - `execution-pass` (execute step): set `relay_chains.status='done'`. Extract SHAs from `input.extractedCommitShas`, write to `workflow_context.executionCommitShas`, set `headAfterExecution=last SHA`, compute `commitRange=baseBeforeExecution..headAfterExecution`. Advance phase (same as `approve`).
   - `execution-fail` (execute step): set `relay_chains.status='escalated'`, `terminalReason=reason`. Close `workflow_phases` row (`outcome='escalated'`). Set `workflows.status='halted'`, `haltReason=reason`.
   - `escalate` (any step): same as `execution-fail` treatment of chain + phase-run + workflow.
4. **Post-commit emissions** (in order, after successful COMMIT):
   - For `chain-continued`: emit `workflow.round-started`.
   - For `phase-advanced`: emit `chain.resolved`, `workflow.phase-done`, then `workflow.phase-started` + `workflow.round-started` (round 1 of next phase).
   - For `workflow-done`: emit `chain.resolved`, `workflow.phase-done`, `workflow.done`.
   - For `workflow-halted`: emit `chain.escalated`, `workflow.phase-done` (outcome=escalated), `workflow.halted`.

**maxRounds enforcement** fires in step 3 under `findings`: if the next review would push `currentRound` past `maxRounds`, the verdict is rewritten to `escalate` before any new row is inserted. The orchestrator log records both the original and the forced verdict.

**Commit SHA extraction.** The orchestrator parses SHAs from the handback during evaluation (see `execution-gate` template rules) and passes them in `extractedCommitShas`. `applyOrchestratorVerdict` is the single site that writes them into `workflow_context`. Driver code, recovery sweep, and advancePhase logic never touch commit metadata directly.

### Validation rules

- `createWorkflow` rejects if collab has another workflow with `status='running'` (enforced by partial unique index + explicit pre-check that returns a friendly error before the index raises `SQLITE_CONSTRAINT`).
- `createWorkflow` rejects if `collab.orchestratorEnabled=false`. Error: `"workflow requires orchestrator-enabled collab; enable AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED and restart broker"`.
- `createWorkflow` rejects if any `roleBindings` value names an agent not bound on the collab.
- `resumeWorkflow` accepts only `status='halted'`. Rejects `status='canceled'` with `"canceled workflows cannot be resumed; start a new workflow"`. **Additionally checks** that no other workflow on the same collab is currently `status='running'` before flipping this one back to `running`; on violation raises `"another workflow is already running on this collab"` (prevents the partial unique index from raising a less-friendly error mid-transaction).
- `cancelWorkflow` accepts `status IN ('running','halted')`; sets `status='canceled'`, `haltReason='canceled by operator'`.
- `haltWorkflow` accepts `status='running'`; used by the driver when a bound agent disappears or another non-verdict precondition fails.
- `beginPhaseRun` asserts workflow exists + `status='running'`, and no open phase run for `currentPhaseIndex`.
- `beginPhaseRun` with `initialHandoffStep='execute'` rejects if `executionBaseHeadSha` is missing or malformed (regex `/^[0-9a-f]{7,40}$/`).
- `createHandoff` with `workflowOwner` set is rejected **unless called from within `applyOrchestratorVerdict` or `beginPhaseRun`** (enforced by an internal caller token). External callers that try to create workflow-owned handoffs directly get an error; this guarantees the single fire-site rule for `workflow.round-started`.
- `applyOrchestratorVerdict` asserts handoff is workflow-owned + chain is still `active` + workflow `status='running'`. Already-terminal handoffs return `"noop-already-applied"`.
- `applyOrchestratorVerdict` on a verdict that would advance into plan-execution rejects if `workspaceHeadSha` is missing or malformed (same regex).

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
whisper workflow inspect <workflow-id>                      # phase history + context
whisper workflow resume <workflow-id>                       # restart halted phase, fresh chain
whisper workflow cancel <workflow-id>                       # distinct terminal status
whisper workflow types                                      # list registered types
```

### `collab inspect` augmentation

```
Chain status: active (round 2/5)
Workflow:     wf_01H... (superpowers-feature-development) "auth rewrite"
  Bindings:   implementer=claude  reviewer=codex
  Phase:      plan-writing (2/4)   Step: review
```

---

## Relay-Monitor Integration

Relay-monitor runs in a **separate process** from the broker daemon. It does NOT subscribe to `BrokerEventBus`. It reads workflow state via the broker control API:

- On startup: `getWorkflow(workflowId)` + `getWorkflowPhaseRuns(workflowId)` populate header.
- Every 500ms: re-poll + diff against last snapshot. Render new rows in event log.

### Header (persistent while workflow active)

```
Workflow: wf_01H... (superpowers-feature-development) "auth rewrite"
Phase:    plan-writing (2/4)   Round: 2/5   Step: review   Chain: relay_ch_...
```

### Event log

```
[14:05:12] ▶ phase-started   spec-refining     claude → codex        step=review
[14:07:33] ↻ round-started   2/5               codex → claude        step=fix
[14:07:55] ↻ round-started   2/5               claude → codex        step=review (recheck)
[14:12:01] ✔ phase-done      spec-refining
[14:12:01] ▶ phase-started   plan-writing      codex → claude        step=implement
```

Icons:
- `▶` phase boundary
- `↻` new step/round within a phase
- `✔` phase closed `done`
- `✖` phase halted (escalated) / canceled

---

## Evaluator Prompt Templates

Selected by `phase.evaluatorPromptKey`. Orchestrator reads it from the handoff's linked phase via the broker.

### `review-loop` (phases: spec-refining, plan-writing, code-review)

System prompt receives:

```
Phase: <phaseName>
Artifact: <resolved path or commit range>
Implementer agent: <agent>
Reviewer agent: <agent>
Current step: <review|fix|implement>
Round: <current> of <max>
Request (latest): <requestText>
Handback: <handbackText>
Handback author: <implementer|reviewer>
```

Allowed verdicts: `approve | findings | delivered | escalate`.

Branching rules (baked into prompt + enforced by orchestrator):

- When `Current step=review`: permitted verdicts = `approve | findings | escalate`. Handback author must be reviewer.
- When `Current step=fix`: permitted verdicts = `delivered | escalate`. Handback author must be implementer. `approve` is NEVER legal from a fix step.
- When `Current step=implement`: permitted verdicts = `delivered | escalate`. Handback author must be implementer.

### `execution-gate` (phase: plan-execution)

System prompt receives:

```
Phase: plan-execution
Plan path: <planPath>
Implementer agent: <agent>
Handback: <agent's final message>
Workspace diff summary: <git status --porcelain>
Most recent commits on HEAD: <git log -n 5 --oneline since workflow start>
```

Allowed verdicts: `execution-pass | execution-fail | escalate`.

Rules:

- `execution-pass` requires: handback contains explicit test-pass marker (regex `tests?\s+(pass|green|ok)` OR embedded `pnpm test` success output) AND handback cites ≥1 commit SHA AND that SHA is present in `git log` since workflow start.
- `execution-fail` when tests failed, not run, or no commits created.
- `escalate` on ambiguous / malformed handback / `confidence<0.5`.

The orchestrator parses commit SHAs from the handback as part of evaluation and passes them to `applyOrchestratorVerdict` via `extractedCommitShas`. That method is the single site that writes `workflow_context.commitRange`, `executionCommitShas`, `headAfterExecution`, and (on code-review fix-delivered) `codeReviewFixShas`.

### Caller-side git reads

The two git-read sites are:
- **Driver** (`kickoffCurrentPhase`): reads HEAD before external-path plan-execution kickoff (phase index start or resume), passes it to `beginPhaseRun.executionBaseHeadSha`.
- **Orchestrator**: reads HEAD before `applyOrchestratorVerdict` on any `plan-writing` review-step evaluation that could approve (and thus advance into plan-execution), passes it as `workspaceHeadSha`. For all other verdicts the parameter may be omitted.

Both callers already live inside the broker process and share access to `collab.workspaceRoot`. Keeping git reads at the caller (and out of SQL transactions) keeps the broker's `BEGIN IMMEDIATE` blocks fast and deterministic. Evaluator prompt templates that embed git metadata (`Workspace diff summary`, `Most recent commits on HEAD`) already rely on orchestrator-side git reads today; this extends that pattern.

---

## Kickoff / Handback / Resume / Cancel

### Kickoff

1. Brainstorm session produces `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`; operator commits.
2. `whisper collab start` with orchestrator enabled.
3. `whisper workflow start --type superpowers-feature-development --spec <path>`.
4. Broker validates (orchestrator enabled, agents bound, no other running workflow), inserts workflow, emits `workflow.created`.
5. Driver handles `workflow.created` → `kickoffCurrentPhase(phase=spec-refining, initialStep=review)` → calls `beginPhaseRun` (atomic); broker emits `workflow.phase-started` + `workflow.round-started` post-commit.
6. Mount panes' auto-accept / auto-handback carries rounds.
7. Operator walks away.

### Handback artifact contract per phase

| Phase | Implementer produces | Where / how |
|---|---|---|
| spec-refining | updates to `{specPath}` | in place |
| plan-writing (implement step) | new file at `{planPath}` | `docs/superpowers/plans/YYYY-MM-DD-<slug>.md` |
| plan-writing (fix step) | updates to `{planPath}` | in place |
| plan-execution | git commits on current branch | handback cites commit SHAs |
| code-review (fix step) | follow-up commits | handback cites additional SHAs |

### Resume

`whisper workflow resume <workflow-id>`

1. Assert `status='halted'` (not `canceled`).
2. Assert no other workflow on this collab is currently `status='running'` (friendly pre-check before the partial unique index).
3. Broker clears `haltReason`, sets `status='running'`, emits `workflow.resumed` post-commit.
4. Driver kicks off fresh chain for current phase via `kickoffCurrentPhase`.
5. Prior escalated `workflow_phases` row preserved; new row inserted for fresh attempt.

### Cancel

`whisper workflow cancel <workflow-id>`

1. Valid from `status IN ('running','halted')`.
2. Closes open phase run with `outcome='superseded'`.
3. Sets `status='canceled'`, `haltReason='canceled by operator'`.
4. Does NOT resolve the handoff chain (chain marked `abandoned` in `relay_chains`).
5. Canceled workflows are terminal; `resume` rejects them.

---

## Autonomous Mode

While a handoff chain is owned by a `status='running'` workflow, mount panes operate in autonomous mode.

### Suppressed

- Handoff card hotkey hints (`[a]ccept [d]ecline [space]defer [h]andback`).
- Local composer fallback on capture failure.
- Force-handback hotkey (`Ctrl+H`) hint.

### Visible

- Relay-monitor header with workflow + phase + step + round.
- Minimal status line in mount panes: `handoff pending (auto-accept in Xs)` / `working (auto-handback on idle)`.
- Escalation banner on halt: `⚠ workflow halted — resume with 'whisper workflow resume <id>'`.

### Enforcement

- Card renderer checks `handoff.workflowId != null`. If set → render autonomous variant.
- Key input handlers for `a/d/h/space/Ctrl+H` are no-ops when the current handoff has `workflowId`.
- Local composer does NOT open on capture failure for workflow-owned chains. Any capture failure on a workflow-owned handoff immediately escalates the chain: the mount pane calls `broker.control.applyOrchestratorVerdict(handoffId, verdict='escalate', reason='capture-failure: <details>', confidence=1.0)` which halts the workflow atomically. The simpler immediate-escalate rule avoids needing a per-handoff retry counter in the schema; the operator recovers via `whisper workflow resume`.

### Manual override

Operator cancels the workflow first (`whisper workflow cancel`). Cancel detaches the chain (marks `abandoned`); mount-pane hotkeys re-enable.

### Idle threshold guidance

Recommended default for workflow runs: `AI_WHISPER_IDLE_THRESHOLD_MS=15000`.

---

## Testing Strategy

### Unit

**WorkflowRegistry**
- `superpowers-feature-development` has exactly 4 phases, correct `initialHandoffStep` per phase.
- Every `stepTemplates[initialHandoffStep]` is non-empty.

**Step transitions**
- `review + approve` → done.
- `review + findings` → next handoff step=fix.
- `fix + delivered` → next handoff step=review.
- `implement + delivered` → next handoff step=review.
- `execute + execution-pass` → done.
- `execute + execution-fail` → escalate.
- `fix + approve` → rejected (illegal verdict for step), forced escalate.

**WorkflowDriver.kickoffCurrentPhase**
- `beginPhaseRun` is called transactionally; on broker failure no orphan rows remain.
- `reviewerRole=null` phase (plan-execution) uses reviewer-bound agent as nominal sender for the execute handoff.
- Plan-execution phase kickoff reads `git rev-parse HEAD` and passes it as `executionBaseHeadSha`.
- `git rev-parse HEAD` failure → workflow halted with a descriptive reason, no phase run inserted.
- Target agent unbound → `broker.control.haltWorkflow` invoked; no phase run inserted.
- Driver does not emit any events directly; every emission tested here comes from the broker method.

**BrokerControl.applyOrchestratorVerdict**
- `review + approve` → chain done, phase-run closed, next phase kicked off atomically; emits `chain.resolved`, `workflow.phase-done`, `workflow.phase-started`, `workflow.round-started` in order.
- `review + approve` on plan-writing phase with `workspaceHeadSha` provided → next phase (plan-execution) starts with `workflow_context.baseBeforeExecution` populated; emissions as above.
- `review + approve` on plan-writing phase WITHOUT `workspaceHeadSha` → transaction aborts, no state change, no emissions.
- `review + approve` on last phase → emits `workflow.done` (no phase-started follows).
- `review + findings` below maxRounds → new `fix` handoff, `currentRound` unchanged, emits `workflow.round-started`.
- `review + findings` at maxRounds → forced escalate; emits `chain.escalated`, `workflow.phase-done`, `workflow.halted`. `evaluatorReason` on the handoff records the normalization (`"max-rounds-reached (5/5)"`).
- `fix + delivered` → new `review` handoff, `currentRound` incremented.
- `fix + delivered` in code-review phase → new SHAs appended, `commitRange` recomputed, next review request text includes updated range.
- `implement + delivered` → new `review` handoff with sender=implementer, target=reviewer.
- `execute + execution-pass` → `commitRange = baseBeforeExecution..headAfterExecution`; phase-advanced. No `workspaceHeadSha` required (next phase is code-review, not plan-execution).
- `execute + execution-fail` → workflow-halted.
- `fix + approve` → illegal verdict, normalized to escalate; `evaluatorReason` records `"illegal-step-verdict: approve"`.
- Second call with same `handoffId` → `action='noop-already-applied'`, no new rows, no new events.
- `confidence < 0.5` → normalized to escalate; `evaluatorReason` records `"low-confidence: <original-reason>"`.
- Evaluator bookkeeping columns on `relay_handoff` (`evaluatorVerdict`, `evaluatorConfidence`, `evaluatorReason`, `evaluatorEvaluatedAt`) are populated for every applied verdict (including normalized ones).

**BrokerControl.beginPhaseRun**
- `initialHandoffStep='execute'` without `executionBaseHeadSha` → rejected.
- `initialHandoffStep='execute'` with malformed SHA → rejected.
- `initialHandoffStep='execute'` with valid SHA → `workflow_context.baseBeforeExecution` set in the same transaction as the phase-run/chain/handoff inserts.

**BrokerControl.haltWorkflow**
- Sets status + reason atomically, emits `workflow.halted`.

**BrokerEventBus**
- Each emission fires exactly once per source-method call.
- No event fires on transaction rollback (transaction boundaries integration-tested).
- Subscribers added/removed don't affect others.

**Validations**
- `createWorkflow` rejects when another running workflow exists for collab.
- `createWorkflow` rejects when `orchestratorEnabled=false`.
- `resumeWorkflow` rejects `status='canceled'`.
- `resumeWorkflow` rejects when another workflow on the same collab is `status='running'` — friendly error raised before the partial unique index would fire.
- Partial unique index prevents concurrent running workflows even under race.
- `createHandoff` with `workflowOwner` set rejects external callers (must be invoked via `beginPhaseRun` / `applyOrchestratorVerdict`'s internal caller token).

**Evaluator template selection**
- `review-loop` enforces step-scoped allowed verdicts.
- `execution-gate` rejects handbacks missing commit SHAs.
- Legacy chains use pre-workflow vocabulary.

**Autonomous mode**
- Workflow-owned handoff hides hotkey hints.
- `a/d/h/space/Ctrl+H` no-op when `workflowId` set.
- Local composer suppressed on capture failure.
- Capture failure on workflow-owned handoff calls `applyOrchestratorVerdict` with `verdict='escalate'`, halting the workflow (no retry counter).

### Integration

**Full cycle (mock LLM)**
- Seed spec file.
- Drive 4 phases through mock orchestrator verdicts: spec review (approve round 1), plan implement + review (approve round 1), execute (pass), code review (approve round 1).
- Assert 4 `workflow.phase-started` + 1 `workflow.done`.
- Assert plan file exists + commits exist.

**Review loop with findings**
- Mock reviewer returns `findings` round 1, `approve` round 2 in spec-refining.
- Assert: 1 `review` → 1 `fix` → 1 `review-recheck` handoff sequence.
- Driver advances phase exactly once.

**Escalation + resume**
- Force plan-writing to `maxRounds` on review step with findings.
- Assert: `workflow.halted` fires; workflow status=halted.
- `resumeWorkflow` → new phase run row; old row preserved with `outcome='escalated'`.

**Cancel distinct from halt**
- Cancel a halted workflow; verify `status='canceled'`.
- `resumeWorkflow` on canceled rejects.

**Broker restart recovery**
- Kick workflow, kill broker mid-phase.
- Restart broker.
- Recovery sweep reads `relay_chains.status` and advances/halts as needed.

**Autonomous mode enforcement**
- Simulate `a` keypress on mount pane during workflow-owned chain.
- Assert handoff state unchanged.

**Orchestrator-enabled gate**
- Attempt `workflow start` on collab with `orchestratorEnabled=false` → rejected with clear error.

### Manual smoke test

`docs/smoke-tests/superpowers-workflow-smoke-test.md`:

1. Brainstorm tiny spec (e.g. "add CLI command that prints 'hello'").
2. Commit spec file.
3. `whisper collab start` + `whisper workflow start --type superpowers-feature-development --spec <path>`.
4. Walk away ~10 min.
5. Verify: workflow reaches `done`, plan exists, commits present, `pnpm test` green.
6. Repeat with ambiguous spec to force escalation.
7. Cancel a halted run; verify resume rejects; verify cancel restores mount-pane hotkeys.

---

## Out of Scope (v1)

- Multiple concurrent workflows per collab.
- Workflow editing at runtime (insert/skip/reorder phases).
- Workflow types beyond `superpowers-feature-development`.
- Swapping role bindings mid-workflow.
- Git branching / PR creation / merge orchestration.
- Web UI / dashboard.
- Per-workflow phase customization stored in DB.
- Artifact schema validation on spec/plan markdown.
- Cost metering / API budget guards per workflow.
- Cross-collab workflow coordination.
- Migrating `RelayOrchestrator` from polling to event-driven (orthogonal).
- Non-null `senderAgent` removal (preserved; execution uses reviewer-bound agent).
