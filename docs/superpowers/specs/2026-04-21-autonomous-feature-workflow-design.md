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
- Changing the fundamental `done | loop | escalate` verdict vocabulary.

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
| `workflow_context` | TEXT (JSON) | carry-forward outputs across phases (e.g. `{"commitRange":"abc..def"}`); default `'{}'` |
| `createdAt` | TEXT | ISO |
| `updatedAt` | TEXT | ISO |

**Constraint:** partial unique index enforces at most one running workflow per collab:
```sql
CREATE UNIQUE INDEX workflows_one_running_per_collab
  ON workflows(collabId) WHERE status = 'running';
```

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

`senderAgent` remains non-nullable. System-initiated execution handoffs use the reviewer-bound agent as nominal sender (see "Execution phase sender" below).

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
- `{commitRange}` — the commit SHA range produced by the `plan-execution` phase handback (populated into workflow context on execution completion; available to `code-review` phase's templates).
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

**Round counting:** `currentRound` in `relay_chains` increments when a new `review`, `implement`, or `execute` step handoff is created. `fix` steps do NOT increment the round counter. `maxRounds` is compared against `currentRound` at the start of each `review`/`implement`/`execute` step.

**maxRounds escalation rule:** if `currentRound >= maxRounds` when a `review` would otherwise fire with verdict=`findings`, orchestrator forces `escalate`.

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
- `currentRound >= maxRounds` on a review step with `verdict='findings'` forces `escalate`.
- Verdict set must match phase's `allowedVerdicts` (derived from `evaluatorPromptKey`); mismatch forces `escalate`.
- Orchestrator logs every verdict for audit.

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

### Fire sites

- `broker.control.resolveChain` → `chain.resolved`
- `broker.control.markEscalated` → `chain.escalated`
- `broker.control.createWorkflow` → `workflow.created`
- `broker.control.createHandoff` (when `workflowOwner` metadata present; see below) → `workflow.round-started`
- `WorkflowDriver.kickoffPhase` → `workflow.phase-started` (after durable phase-run + chain + initial handoff exist)
- `WorkflowDriver.advancePhaseIfOwned` → `workflow.phase-done`
- `WorkflowDriver.haltWorkflowIfOwned` → `workflow.halted`
- `WorkflowDriver` on workflow completion → `workflow.done`
- `broker.control.resumeWorkflow` → `workflow.resumed`
- `broker.control.cancelWorkflow` → `workflow.canceled`

`workflow.round-started` fires on every `createHandoff` for workflow-owned chains, including round 1. Relay-monitor suppresses the `↻` render for round 1 because `▶ phase-started` already covers it; programmatic consumers still receive the event.

---

## WorkflowDriver Loop

Event-driven primary path + recovery sweep fallback.

### Subscribers

```ts
bus.on('workflow.created', (e) => kickoffPhase(e.workflowId));
bus.on('chain.resolved',   (e) => advancePhaseIfOwned(e.chainId));
bus.on('chain.escalated',  (e) => haltWorkflowIfOwned(e.chainId, e.reason));
bus.on('workflow.resumed', (e) => kickoffPhase(e.workflowId));
```

### `kickoffPhase(workflowId)`

All work happens inside a **single broker transaction** via `broker.control.beginPhaseRun`:

1. Load workflow record. Validate `status='running'`.
2. Read `PhaseConfig` from registry via `workflowType` + `currentPhaseIndex`.
3. Resolve template placeholders + roles.
4. Assert both bound agents are present on the collab. If not → `haltWorkflow(reason: "target agent <x> not bound")`.
5. Call `broker.control.beginPhaseRun({ workflowId, phaseIndex, phaseName, initialHandoffStep, kickoffText, sender, target, maxRounds })`. Broker in one transaction:
   - Inserts `relay_chains` row (`status='active'`, `currentRound=1`, `maxRounds=phase.maxRounds`).
   - Inserts `workflow_phases` row tying the new chain to the workflow+phaseIndex.
   - Inserts `relay_handoff` row with `handoffStep`, `workflowId`, `phaseRunId`, `senderAgent`, `targetAgent`, `requestText`.
   - Returns `{ phaseRunId, chainId, handoffId }`.
6. Emit `workflow.phase-started` + `workflow.round-started`.
7. Update `workflows.updatedAt`.

### `advancePhaseIfOwned(chainId)`

Only acts if the chain is workflow-owned and workflow is `status='running'`.

1. Close current `workflow_phases` row: `endedAt = now`, `outcome='done'`.
2. Emit `workflow.phase-done`.
3. For execute phase: extract commit SHAs from the evaluator's accepted handback, merge into `workflows.workflow_context` JSON as `{"commitRange":"<first>..<last>"}`. These feed `{commitRange}` for subsequent phases.
4. Increment `workflows.currentPhaseIndex`.
5. If past last phase → `workflows.status='done'`, emit `workflow.done`.
6. Else → call `kickoffPhase`.

### `haltWorkflowIfOwned(chainId, reason)`

1. Guard: chain workflow-owned + workflow `status='running'`.
2. Close current phase run: `endedAt = now`, `outcome='escalated'`.
3. `workflows.status='halted'`, `haltReason=reason`.
4. Emit `workflow.halted`.

### Recovery sweep

Every 30s, for each workflow with `status='running'`:

- Read latest `workflow_phases` row for `currentPhaseIndex`.
- Read the linked `relay_chains.status` (durable per-chain terminal state).
- If terminal (`done`) but workflow hasn't advanced → `advancePhaseIfOwned`.
- If terminal (`escalated`) but workflow hasn't halted → `haltWorkflowIfOwned`.
- If no phase run exists for current index → `kickoffPhase` (covers missed events during crash).

### Concurrency

- Driver uses `BEGIN IMMEDIATE` around each event handler's workflow row read + state transition.
- Idempotency: `advancePhaseIfOwned` checks whether a phase row for the next index already exists with a live chain before calling kickoff.

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

  // Workflow-aware handoff creation (atomic phase-run + chain + handoff)
  beginPhaseRun(input: {
    workflowId: string;
    phaseIndex: number;
    phaseName: string;
    initialHandoffStep: HandoffStep;
    kickoffText: string;
    sender: "claude" | "codex";
    target: "claude" | "codex";
    maxRounds: number;
    now: string;
  }): { phaseRunId: string; chainId: string; handoffId: string };

  // Standard handoff gains workflowOwner metadata
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

  getWorkflow(workflowId: string): WorkflowRecord | null;
  listWorkflows(filter?: {
    collabId?: string;
    status?: "running" | "halted" | "done" | "canceled";
  }): WorkflowRecord[];
  getWorkflowPhaseRuns(workflowId: string): PhaseRunRecord[];
}
```

### Validation rules

- `createWorkflow` rejects if collab has another workflow with `status='running'` (enforced by partial unique index + pre-check).
- `createWorkflow` rejects if `collab.orchestratorEnabled=false`. Error: `"workflow requires orchestrator-enabled collab; enable AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED and restart broker"`.
- `createWorkflow` rejects if any `roleBindings` value names an agent not bound on the collab.
- `resumeWorkflow` accepts only `status='halted'`. Rejects `status='canceled'` with `"canceled workflows cannot be resumed; start a new workflow"`.
- `cancelWorkflow` accepts `status IN ('running','halted')`; sets `status='canceled'`, `haltReason='canceled by operator'`.
- `beginPhaseRun` asserts workflow exists + `status='running'`, and no open phase run for `currentPhaseIndex`.
- `createHandoff` with `workflowOwner` set asserts the `phaseRunId` exists, belongs to the workflow, and chain is still active.

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

Extracted commit SHAs are captured into `workflows.workflow_context.commitRange` by the broker when chain resolves.

---

## Kickoff / Handback / Resume / Cancel

### Kickoff

1. Brainstorm session produces `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`; operator commits.
2. `whisper collab start` with orchestrator enabled.
3. `whisper workflow start --type superpowers-feature-development --spec <path>`.
4. Broker validates (orchestrator enabled, agents bound, no other running workflow), inserts workflow, emits `workflow.created`.
5. Driver handles `workflow.created` → `kickoffPhase(phase=spec-refining, initialStep=review)` → calls `beginPhaseRun` (atomic) → emits `workflow.phase-started` + `workflow.round-started`.
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
2. Broker clears `haltReason`, sets `status='running'`, emits `workflow.resumed`.
3. Driver kicks off fresh chain for current phase.
4. Prior escalated `workflow_phases` row preserved; new row inserted for fresh attempt.

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
- Local composer does NOT open on capture failure for workflow-owned chains. Handback retries once; on second failure, orchestrator escalates.

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

**WorkflowDriver.kickoffPhase**
- `beginPhaseRun` is called transactionally; on broker failure no orphan rows remain.
- `implementerRole=null` phase uses reviewer-bound agent as sender (execution handoff).
- Target agent unbound → halts workflow without inserting phase run.

**WorkflowDriver.advancePhaseIfOwned**
- Last phase → `workflow.status='done'`, emits `workflow.done`.
- Middle phase → next phase kickoff fires.
- Execution phase → extracts commit SHAs into `workflow_context.commitRange`.
- Idempotent under duplicate events.

**WorkflowDriver.haltWorkflowIfOwned**
- Sets status + reason atomically.
- Emits `workflow.halted`.

**BrokerEventBus**
- Each emission fires exactly once per source-method call.
- Subscribers added/removed don't affect others.

**Validations**
- `createWorkflow` rejects when another running workflow exists for collab.
- `createWorkflow` rejects when `orchestratorEnabled=false`.
- `resumeWorkflow` rejects `status='canceled'`.
- Partial unique index prevents concurrent running workflows even under race.

**Evaluator template selection**
- `review-loop` enforces step-scoped allowed verdicts.
- `execution-gate` rejects handbacks missing commit SHAs.
- Legacy chains use pre-workflow vocabulary.

**Autonomous mode**
- Workflow-owned handoff hides hotkey hints.
- `a/d/h/space/Ctrl+H` no-op when `workflowId` set.
- Local composer suppressed on capture failure.

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
