# ai-whisper workflow pause / resume - design

Date: 2026-05-27
Status: approved-for-planning

## Problem

ai-whisper autonomous workflows run to completion or **escalate** (status
`halted`) when the evaluator cannot resolve a phase. There is no neutral
operator control to **freeze a healthy, running workflow in place** and let it
**continue afterward**.

During a week of dogfooding this gap caused a concrete, expensive failure mode.
A glitch in an artifact (the spec/plan/source the agents iterate on) steered
both agents in the wrong direction, and the autonomous loop kept iterating on
the bad artifact round after round. The operator's only options were:

- let the loop keep burning rounds (and tokens) on the wrong thing, or
- `halt` the workflow — but `halt` is a designed *escalation* exit. It pollutes
  the review trail with an escalation reason and is semantically "the system
  gave up," not "the human is intervening for a moment."

What the operator actually needed: **pause** the running workflow, edit the
artifact while the broker daemon keeps running in the background (idle checks,
handoff/handback delivery, orchestration), then **resume** — and have the agents
*know the artifact changed* so they re-read and re-evaluate instead of
continuing off stale session context.

### Why pausing is non-trivial today

Two independent background drivers keep the loop moving, and **both** must be
frozen for a real pause — freezing one is not enough:

1. **Orchestrator poll** (`packages/cli/src/runtime/relay-orchestrator.ts`) — a
   `setInterval` (~1s) whose `pollOnce` claims handoffs pending orchestration,
   evaluates them, applies a verdict, and creates/delivers the next loop
   handoff. It is **collab-scoped and not workflow-status-aware** — it never
   checks whether a workflow is paused before claiming. This is what re-issues
   the next round onto a glitchy artifact.
2. **Idle auto-handback / auto-accept** (`packages/cli/src/runtime/
   mounted-turn-owned-relay.ts` `checkIdleActions`) — a separate, mount-side
   path that auto-accepts a pending handoff (injecting the request into the
   agent's prompt) and auto-delivers the captured handback. Pausing the
   orchestrator alone does **not** stop this path from pushing a turn across.

There is also a session-context staleness trap: editing the artifact file fixes
the **source of truth**, but the agents' live session context still holds the
wrong direction. Resume must be able to tell the agents what changed so they
re-read and re-evaluate, rather than continuing to "strip ahead doing the wrong
thing" — which is useless and expensive.

### Out of scope (explicitly)

- The existing `halted → running` resume behavior. It stays exactly as today;
  this work only **adds** a paused branch.
- The pre-existing **mount-side manual input pause** (`isPausedInput` in
  `mounted-turn-owned-relay.ts`, gating auto-accept/auto-handback). That is a
  different layer (per-mount, manual) and is left untouched. Workflow pause is a
  new, broker-side, workflow-level status — the two are kept strictly separate.
- A mounted-pane hotkey for pause. Trigger is CLI-only (see §6).

## Goals

- Operator can pause a healthy running workflow and resume it later, with no
  escalation and no pollution of the review trail.
- Pause freezes **all** delivery/orchestration drivers — current and future —
  through a single enforcement point that a new driver cannot bypass by accident.
- The in-flight turn is never violently interrupted by the system (no killed
  PTY); the loop quiesces at the next boundary.
- On resume, when the operator changed artifacts during the pause, the agents
  receive a precise list of files changed **since the workflow quiesced** plus
  the operator's intent, and are required to re-read and re-evaluate before
  continuing. The snapshot baseline is taken at the quiesce boundary (not at the
  pause-command instant) so an in-flight agent turn's writes are not attributed
  to the operator (see §3 / §4).
- Zero regression on the existing working workflows
  (`spec-driven-development`, `ralph-loop`, `complex-bug-fixing`) and on the
  existing `halted → running` resume path.

## Design

### 1. State model

- Add `"paused"` to `WorkflowStatus`
  (`packages/broker/src/storage/repositories/workflow-repository.ts`). `status`
  is a TEXT column, so this is **additive with no DB schema migration**
  (consistent with the project's additive-schema convention).
- Transitions:
  - `running → paused` — `pause`, valid **only** from `running`.
  - `paused → running` — `resume`.
  - `halted → running` — `resume`, unchanged from today.
- Pause metadata is stored in the existing `workflow_context` JSON (no new
  columns), via `updateWorkflowContext`:
  - `pausedAt: string` — ISO timestamp of the pause command.
  - `pauseSnapshotRef: string | null` — workspace-tree snapshot reference,
    captured at the **quiesce boundary** (see §3/§4), not at the pause-command
    instant. `null` until the boundary is reached (or if snapshotting is
    unavailable); a resume before the boundary degrades to a message-only notice
    (see §5/§7).
  - `resumeNotice: string | null` — transient; set at resume, consumed once by
    the delivery path, then cleared (see §5).

#### Concurrency: paused occupies the active workflow slot

Today the one-workflow-per-collab invariant counts and indexes only
`status = 'running'`: `countRunningWorkflowsForCollab`
(`workflow-repository.ts:157-167`) and the partial unique index
`workflows_one_running_per_collab ... WHERE status = 'running'`
(`apply-migrations.ts:229-230`). A paused workflow would free that slot, letting
a second workflow start during the pause and making the later resume conflict or
violate the single-active-workflow assumption.

Therefore **`paused` is treated as occupying the active slot**, identical to
`running`, everywhere the invariant is enforced:

- `countRunningWorkflowsForCollab` (and any "is there an active workflow" guard
  feeding `createWorkflow`) counts `status IN ('running', 'paused')`. Rename to
  reflect the "active" set, or add an explicit active-set helper.
- The partial unique index predicate widens to
  `WHERE status IN ('running', 'paused')`. This is a one-line index
  redefinition delivered as an idempotent migration in `apply-migrations.ts`
  (`DROP INDEX IF EXISTS workflows_one_running_per_collab;` then recreate with
  the widened predicate). Safe because at most one workflow is active today and
  a workflow is never both `running` and `paused`.
- `createWorkflow` rejects starting a new workflow while an active
  (`running` **or** `paused`) workflow exists for the collab, with a clear error
  pointing the operator at the paused workflow's id.

### 2. The chokepoint gate (single shared predicate)

A single shared broker predicate is the enforcement point:

```
isWorkflowDeliverySuspended(handoffId) -> boolean
```

It returns `true` when the handoff belongs to a workflow whose status is
`paused`, and `false` for legacy/non-workflow handoffs (which therefore keep
flowing exactly as today).

**Every** orchestration/delivery entry method in the broker control layer
(`packages/broker/src/control/create-control-service.ts`) calls it:

- `listRelayHandoffsPendingOrchestration` — exclude handoffs of paused
  workflows from the pending list (a join on workflow status in
  `relay-handoff-repository.ts`).
- `claimRelayHandoffForOrchestration` — re-check and **refuse** (return `null`)
  if the workflow is paused. This closes the race where a workflow is paused
  between the orchestrator's list and its claim.
- handoff **auto-accept** delivery (`acceptPendingHandoff`) — refuse while paused.
- handback **auto-delivery** control method — gate the *delivery/orchestration*
  step (verdict + next handoff creation) while paused, **not** the recording of a
  completed in-flight handback. An already-accepted turn's handback is still
  recorded (§3) so the workflow can reach the quiesce boundary; only its
  downstream orchestration is deferred until resume. The predicate suspends what
  would create or deliver new work, never the persistence of the final write
  that lets the loop quiesce.

Driver hot loops get **zero edits**: `relay-orchestrator.ts` and the
`checkIdleActions` path are unchanged. The invariant is "all delivery/
orchestration entry points call the predicate," which a future driver inherits
by going through a control method — it cannot silently bypass the gate.

> Rationale: this mirrors how the 0.2.1 one-active-collab invariant was made
> unforgeable at the data/control layer rather than re-checked per caller.

### 3. Quiesce semantics

Decision: **let the in-flight turn finish; deliver no new handoff while paused.**

- The system never kills a live PTY turn. An already-accepted handoff whose
  agent is mid-work is left alone.
- A handback capture that completes may still be **recorded**, but its
  **orchestration (verdict + next handoff) is deferred**, because the
  orchestrator gate excludes paused workflows.
- No new handoff is delivered or created while paused.
- Net effect: the in-flight turn completes, then the loop stops at the next
  boundary until resume.

**Quiesce boundary** — the well-defined point at which the workflow has no
agent actively writing: there is no `accepted`-but-not-yet-handed-back handoff
for the workflow (either none was in flight at pause, or the in-flight turn's
handback has now been recorded). This boundary is what makes the resume diff
sound: the workspace snapshot baseline (§4) is captured here, so every change
detected at resume post-dates the last agent write and is attributable to the
operator.

### 4. Pause command

`whisper workflow pause <id>`
(`packages/cli/src/commands/workflow/pause.ts`, wired in
`packages/cli/src/create-cli.ts`):

1. Resolve the workflow; assert status is `running`, else exit with a clear
   error (e.g. "workflow <id> is <status>, only running workflows can be
   paused").
2. Set status `paused` (with `pausedAt`). Drivers quiesce on their next poll.
   The active-slot invariant (§1) now keeps the workflow's collab slot occupied,
   so no second workflow can start while it is paused.
3. **Snapshot the workspace tree at the quiesce boundary**, not now. The pause
   command does not capture the snapshot itself, because an in-flight agent turn
   may still be writing (§3). Instead the broker captures `pauseSnapshotRef`
   when the workflow reaches the quiesce boundary (§3): immediately if no
   `accepted` handoff is in flight, otherwise when that handoff's handback is
   recorded. The snapshot primitive is likely `git stash create`, which records
   the exact working tree as a dangling commit **without mutating the tree or
   index**; scope is tracked, non-ignored files, excluding `.ai-whisper/` run
   directories. If the workspace is not a git repo or the primitive is
   unavailable, `pauseSnapshotRef` stays `null` and resume degrades (see §5/§7).

### 5. Resume command + change-notice

`whisper workflow resume <id> [--message "<note>"]`
(extends `packages/cli/src/commands/workflow/resume.ts`):

1. Branch on current status:
   - `halted` → existing behavior, untouched.
   - `paused` → new branch below.
   - any other status → reject with a clear error.
2. **(paused branch)** Compute the set of operator-changed files: diff the
   current workspace tree against `pauseSnapshotRef`, scoped to tracked,
   non-ignored files excluding `.ai-whisper/`. Because the snapshot baseline is
   the **quiesce boundary** (§3/§4) — taken after any in-flight agent turn's
   final write — every change in the delta post-dates the last agent write and
   is attributable to the operator. (If `pauseSnapshotRef` is `null` — snapshot
   unavailable, or the operator resumed before the workflow quiesced — there is
   no baseline to diff, so the changed-file set is empty; the notice is then
   driven by `--message` alone per steps 3–4.)
3. If files changed **or** `--message` was provided, compose a **resume notice**:

   ```
   While paused, the operator modified these files:
     - <path>
     - <path>
   Re-read them before continuing.
   Operator note: <message, if any>
   Re-evaluate whether your current direction still holds; correct course before
   proceeding.
   ```

   - File list is always included when changes are detected.
   - The operator note line is omitted when no `--message` was given.
   - The notice is stored as `resumeNotice` on `workflow_context`. The delivery
     path **prepends it to the next outgoing request** — whether that is a
     handoff already pending accept, or the next loop handoff the orchestrator
     creates after resume — then clears `resumeNotice` after one consumption.
   - It reaches whichever agent owns the next baton first; the other agent sees
     the corrected artifact when its turn comes (single baton, not simultaneous).
4. If no files changed **and** no `--message` → plain resume (no notice).
5. Set status `running`; drivers un-gate on their next poll.

### 6. Agent guidance (CLI-only trigger, prompt-fragment channel)

Trigger is **CLI-only** — no mounted-pane hotkey. The agents must be able to
self-serve the common in-session case: the user interrupts a busy agent
(typically Ctrl+C) and types something like "pause the workflow, I need to fix
X." On that instruction the agent must:

1. Find the active workflow id (e.g. `whisper workflow list`).
2. Run `whisper workflow pause <id>`.
3. Acknowledge and **stop working**.

**Vehicle: two complementary channels — a canonical prompt fragment plus a
section in the existing kickoff skills. No new standalone skill.**

1. **Canonical prompt fragment** — primary, reliable channel. This case fires
   *mid-workflow* when the agent is not invoking any skill, so the in-context
   guidance at that moment must ride the workflow handoff prompt the agent
   already receives (the same mechanism the review protocol uses). Tests target
   this fragment + the handoff integration.
2. **Section in the existing bundled kickoff skills** (`ai-whisper-sdd`,
   `ai-whisper-ralph`, `ai-whisper-bugfix`) — for discoverability. These skills
   are already loaded at kickoff and retained in the agent's session context, so
   a "how to act when the user asks to pause the workflow (given a workflow id)"
   section reinforces the prompt fragment. This augments skills that already
   exist; it does **not** add a new thin standalone skill (which the prior
   `do-not-bundle-wf-review-as-a-skill` decision rejected for adding package
   surface and drift risk without behavior).

Provider gotcha to encode in the guidance: the Codex CLI exits its session on
Ctrl+C **at an idle prompt** (a mid-task Ctrl+C only interrupts the running
task). The guidance must reflect that the user typically interrupts a *busy*
agent before issuing the pause instruction, and must not assume Ctrl+C is a safe
no-op.

## Error handling & edge cases (must be covered by tests)

- `pause` on `done` / `canceled` / `halted` / already-`paused` → reject with a
  clear message; no state change.
- `resume` on `running` / `done` / `canceled` → reject with a clear message.
- **Regression guard:** the `halted → running` resume code path and its existing
  tests are untouched; paused is a strictly additive branch. Existing
  end-to-end workflow tests must stay green.
- Pause lands while a handback is awaiting orchestration → that (pre-edit)
  handback is evaluated on resume; the resume notice on the *next* handoff
  corrects course. This is documented, accepted behavior.
- Workspace has pre-existing uncommitted changes at pause → the quiesce-boundary
  snapshot captures the then-current tree; only the boundary→resume delta is
  reported on resume.
- In-flight agent turn is still writing when pause lands → snapshot is deferred
  to the quiesce boundary (after that turn's handback is recorded), so the
  turn's writes are **not** attributed to the operator.
- Operator resumes before the workflow quiesces (snapshot not yet captured) →
  `pauseSnapshotRef` is `null`; no file diff, notice driven by `--message` alone.
- Starting a new workflow while one is `paused` for the same collab → rejected by
  the active-slot guard / unique index, with an error naming the paused
  workflow's id. The migration that widens the index must not fail when a paused
  workflow already exists.
- Nothing changed during pause and no `--message` → no notice; plain resume.
- Not a git repo / `git stash create` unavailable → `pauseSnapshotRef` is
  `null`; resume cannot diff, so the notice falls back to the operator
  `--message` only (or no notice if none given). Resume still succeeds.
- Race: workflow paused between the orchestrator's list and claim → `claim`
  re-checks the predicate and refuses; no turn is delivered.
- Legacy / non-workflow handoffs → predicate returns `false`; delivered exactly
  as today.

## Testing strategy

- **Unit:** the gate predicate (paused vs running vs legacy/no-workflow);
  pause/resume status transitions and rejections; resume-notice composition
  (changed files only, message only, both, neither); snapshot-unavailable
  degrade.
- **Repository:** `listRelayHandoffsPendingOrchestration` excludes paused
  workflows' handoffs and still returns running + legacy ones; `claim` refusal
  under paused.
- **Active-slot reservation:** the active-set count/guard treats `paused` as
  occupying the slot; `createWorkflow` rejects a second workflow while one is
  paused; the widened unique index rejects a duplicate active workflow and its
  migration is idempotent (re-run with an existing paused workflow succeeds).
- **Quiesce-boundary snapshot:** snapshot is captured only after an in-flight
  turn's handback is recorded (immediately if none in flight); a turn that
  writes files after the pause command does not appear in the resume diff;
  resume before the boundary yields a `null` baseline and a message-only notice.
- **Integration / control:** pause during an in-flight turn quiesces the loop
  (no new handoff delivered); resume re-issues with the notice prepended to the
  next request; the `halted → running` path is unchanged.
- **Regression:** existing `spec-driven-development`, `ralph-loop`, and
  `complex-bug-fixing` workflow tests stay green.
- Verification gate before done: `pnpm lint`, `pnpm build`, `pnpm test`,
  `pnpm typecheck`.

## Affected components

- `packages/broker/src/storage/repositories/workflow-repository.ts` —
  `WorkflowStatus` enum; `countRunningWorkflowsForCollab` → active-set
  (`running` + `paused`) count/helper; pause/resume helpers if needed.
- `packages/broker/src/storage/apply-migrations.ts` — widen the
  `workflows_one_running_per_collab` partial unique index predicate to
  `status IN ('running', 'paused')` via an idempotent drop-and-recreate.
- `packages/broker/src/storage/repositories/relay-handoff-repository.ts` —
  pending query join on workflow status.
- `packages/broker/src/control/create-control-service.ts` —
  `isWorkflowDeliverySuspended` predicate; gate at every delivery/orchestration
  entry method.
- `packages/broker/src/control/workflow-control.ts` — pause/resume logic,
  snapshot capture, diff, resume-notice plumbing.
- A workspace snapshot/diff utility (git-backed).
- `packages/cli/src/create-cli.ts` — wire `pause`; extend `resume` with
  `--message`.
- `packages/cli/src/commands/workflow/pause.ts` (new) and
  `packages/cli/src/commands/workflow/resume.ts` (extended).
- Canonical workflow-handoff prompt fragment carrying the in-session "pause the
  workflow" operator-control guidance, plus a pause-guidance section added to
  the existing kickoff skills (`ai-whisper-sdd`, `ai-whisper-ralph`,
  `ai-whisper-bugfix`) — no new standalone skill (see §6).

This spans ~9-10 files; the implementation plan (writing-plans) will decompose
it into ordered, independently verifiable tasks.
