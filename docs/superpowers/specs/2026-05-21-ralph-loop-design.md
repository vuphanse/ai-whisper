# Ralph Loop Workflow — Design Spec

**Status:** Approved design (brainstorm complete) — ready for implementation planning.
**Date:** 2026-05-21

## 1. Problem & motivation

The "ralph" technique (after Geoffrey Huntley) is the simplest autonomous coding loop that works: write one prompt describing a goal, then run an agent in a `while true` loop feeding it the same prompt every iteration. Each run the agent reads the current repo state plus a progress file, picks the next unfinished piece, does just that piece, and exits; a fresh agent restarts with the identical prompt and grinds the next piece. It is brute-force-effective for large, repetitive goals ("migrate every `.js` file to TS", "implement every endpoint in this spec", "fix every lint error").

Ralph has two well-known weaknesses:

1. **No quality bar.** The same model that produces the work is the only one judging it "done." There is no adversary and no acceptance contract, so the output frequently misses the bar.
2. **Amnesia under fresh context.** Classic ralph wipes context every iteration (memory lives in the filesystem). That kills drift and context-bloat, but it also discards the *corrections* learned in prior iterations — so the agent re-makes the same mistake forever, because the lesson lived in the wiped conversation. Pure-checklist ralph loops do exactly this.

**What ai-whisper uniquely adds.** ai-whisper already runs two independent mounted agents (codex + claude) driven by a relay orchestrator with a cross-model LLM evaluator that gates every handoff, plus durable persistence, a dashboard, verdict history, cost tracking, and escalation-on-no-progress. Applied to ralph, this turns "fast slop" into "fast and meets the bar":

- An **independent reviewer** (a different model) gates each increment and the final "done" — fresh eyes the self-loop can never give itself.
- A **real acceptance contract**: the loop runs against explicit completion criteria, and exit is "criteria met," not an iteration count.
- **Durable, observable, resumable** orchestration with escalation when rounds stop making progress.
- The amnesia problem is solved by **persisting corrections to a durable learnings file** that every iteration re-reads — the reviewer generates the corrections, the implementer records the generalizable ones, and they survive the soft reset.

## 2. Goal & non-goals

**Goal:** add a new workflow type `ralph-loop` that grinds an open-ended goal to completion via a gated self-loop, reusing ai-whisper's existing relay + evaluator + escalation machinery.

**Non-goals (v1):**
- A dedicated `/ralph` agent skill (CLI-driven first; a skill can follow later, like `ai-whisper-sdd`).
- True fresh-context-per-iteration via session restart (v1 uses a soft reset; see §12).
- A configurable "reviewer-optional / periodic-review" cheap mode (v1 reviews every item; see §12).
- Any change to spec-driven-development behavior.

## 3. Core model

A two-loop, gated self-loop over a single goal:

- **Inner loop (per item):** the implementer reads the goal + `PROGRESS.md` + `LEARNINGS.md`, does the next chunk, and hands back; that implementer handback routes to the reviewer (the `delivered` hop, §6.0). The reviewer reviews; the evaluator returns `findings` (implementer fixes, appends a generalizable lesson to `LEARNINGS.md`, hands back — repeat, capped by `maxRounds`) or `approve` (item done).
- **Outer loop (over items):** on an item `approve`, control re-kicks the **same** phase for the next item (it does **not** advance to a different phase), incrementing an iteration counter.
- **Completion:** when the implementer determines no work remains, it hands off a **completion claim**. The reviewer runs the acceptance-criteria gate; the evaluator returns `complete` (goal met → workflow `done`) or `findings` (gaps become the next item, loop continues).

The implementer is the only agent that edits the repo and the memory files; the reviewer only judges and reports.

## 4. Artifacts & memory

### 4.1 Goal file (input)
The "prompt": a description of the work plus explicit completion/acceptance criteria. Supplied by the user via the existing `--spec <path>` plumbing (`specPath`); no new input field. May optionally specify its own chunk granularity (see §5.4). **Checklist-style control:** because the run-state directory is keyed on a `workflowId` the user does not know before start (and kickoff happens immediately), the user cannot pre-create `PROGRESS.md`. Instead, a user who wants an explicit checklist **puts it in the goal file**; the kickoff instructs the implementer to copy that checklist into `PROGRESS.md` on the first item. For open-ended goals the implementer derives and records items itself.

### 4.2 Durable memory (run-state)
Two files per run, written by the **implementer only** (sole writer — avoids edit conflicts on a shared file):

- `<workspace>/.ai-whisper/ralph/<workflowId>/PROGRESS.md` — the work ledger: done / in-progress / remaining. The implementer creates and maintains it (initializing from the goal file's checklist if one is present, per §4.1; otherwise deriving items for open-ended goals).
- `<workspace>/.ai-whisper/ralph/<workflowId>/LEARNINGS.md` — accumulated **generalizable** corrections ("pattern X breaks Y → do Z", constraints discovered, decisions). The implementer appends here during a fix step **only for lessons likely to recur on other items**; one-off typos are just fixed. Re-read at the start of every item. This is the anti-amnesia mechanism.

Keying the directory on `workflowId` guarantees uniqueness and ties each run's memory to its broker record, so multiple ralph runs in the same workspace over time never collide and prior runs' memory remains inspectable. The broker injects this directory path into the kickoff/step templates (`{ralphDir}`, §5.5) so the implementer always knows where to read and write.

**Who creates what:** the broker creates the **directory** and the self-`.gitignore` at setup (§6.1) — these must exist for the ignore to take effect. The `PROGRESS.md` and `LEARNINGS.md` files themselves are created and maintained by the **implementer** (the sole-writer principle); the kickoff template instructs it to create them if absent. The broker does not seed file contents.

### 4.3 Scoping: inner (ephemeral) vs outer (durable)
- **Inner-loop state is ephemeral and lives in the relay DB** — the specific reviewer findings, the round counter, and verdicts are already persisted as handoffs/verdicts. They are **not** written to the markdown artifacts.
- **Outer-loop memory is the two markdown files.** Only generalizable lessons graduate from inner → outer.

### 4.4 Git tracking & authority
- ai-whisper writes bookkeeping **only** under `<workspace>/.ai-whisper/` (its namespace). At workflow start it writes `<workspace>/.ai-whisper/.gitignore` containing a single `*` — the standard "ignore everything in this folder" pattern. Git then ignores the entire `.ai-whisper/` subtree **without ai-whisper editing the user's root `.gitignore` or any tracked file.** The run-state files are therefore never committed.
- **Work commits:** the implementer auto-commits its actual code changes per item. This is the workflow's explicit, documented purpose (mirroring SDD's `plan-execution` phase, which already commits); authority comes from the user starting an autonomous workflow whose stated job is to make and commit changes. The `.ai-whisper/` bookkeeping is never part of those commits (it is gitignored).

## 5. Workflow definition (registry)

`ralph-loop` is registered in `workflow-registry.ts` as a `WorkflowDefinition` with a single **looping** phase. SDD definitions are unaffected because the new behavior is gated entirely behind the loop descriptor.

### 5.1 Loop descriptor & phase shape
Add an optional loop descriptor to the phase config (and corresponding type). A phase with no descriptor behaves exactly as today (SDD path). The single ralph phase carries:
- `initialHandoffStep: "implement"` — the implementer does work **first**; it does not start with `review` (which would ask the reviewer before any work exists).
- `reviewerRole: "reviewer"` — the reviewer is in the loop (every item is reviewed).
- `maxRounds: number` — the inner review/fix cap (existing field).
- `repeatUntilComplete: true` — the loop descriptor flag.
- `maxIterations: number` — the outer safety cap (total items before a forced halt).

### 5.2 Roles & defaults
- Roles: `implementer` + `reviewer`.
- Defaults: `defaultImplementer: "claude"`, `defaultReviewer: "codex"` (overridable via `--implementer` / `--reviewer`, matching SDD).

### 5.3 Evaluator
- `evaluatorPromptKey: "ralph-loop"` — a new prompt key (see §7).

**Required plumbing — the configured key must reach the orchestrator.** Today the orchestrator does **not** read the phase's `evaluatorPromptKey`; it derives the key from `handoffStep` alone, hard-coding `"review-loop"` unless the step is `"execute"` (`packages/cli/src/runtime/relay-orchestrator.ts` ~line 165). So a phase-configured `"ralph-loop"` key would never be used. The implementation **must** plumb the phase's configured `evaluatorPromptKey` through the handoff workflow metadata (`getHandoffWithWorkflowMeta` → include the phase's `evaluatorPromptKey`) and have the orchestrator use that value instead of the `handoffStep`-derived default (falling back to the existing derivation when the metadata key is absent, so SDD is unaffected). The type unions must also be widened (see §6.2).

### 5.4 Templates & chunk-sizing heuristic
The kickoff/step templates instruct the implementer to:
- Read the goal, `PROGRESS.md`, and `LEARNINGS.md` (treat them as ground truth; re-orient from them rather than relying on prior conversation — the soft reset).
- Pick the next unfinished chunk, sized by this heuristic: **"Pick the smallest independently-verifiable unit of real progress (e.g. one file, one endpoint, one bug). It must be small enough to finish and pass review in a single round; if a chunk fails review twice, split it. The goal file may specify its own granularity, which overrides this default."** (Sizing matters because inner escalation aborts the whole workflow — see §6/§10 — so the bias is toward small, reliably-reviewable chunks.)
- Do the work, update `PROGRESS.md`, commit the work, and hand back ending with the exact **item-delivery marker** on its own line: `[[RALPH:ITEM-DELIVERED]]`.
- When `PROGRESS.md` and the repo show no remaining work, hand back ending with the exact **completion-claim marker** on its own line instead: `[[RALPH:GOAL-COMPLETE]]`.
- During a fix step, apply the reviewer's findings, append any generalizable lesson to `LEARNINGS.md`, and hand back (ending again with `[[RALPH:ITEM-DELIVERED]]`).

The two marker strings are **exact, literal tokens** (not natural-language phrases) because classification of the handback as item-delivery vs completion-claim controls whether `approve` loops or `complete` terminates (§6, §7). Templates must emit them verbatim and tests must assert the evaluator routes on them (§11); implementations must not fall back to fuzzy natural-language detection.

(The autonomous-workflow guardrails from SDD's templates apply: no human is in the loop; never ask for confirmation/permission/clarification; replies must be substantive, not a bare word.)

### 5.5 `{ralphDir}` injection
The kickoff/step templates reference `{ralphDir}` (the run's memory directory, §4.2). This value is **not** in today's render set (kickoff rendering passes only `specPath`, `planPath`, `commitRange` — `packages/broker/src/control/workflow-control.ts` ~line 413, and the driver's render in `workflow-driver.ts`). The implementation **must** compute `ralphDir` (deterministically: `<workspaceRoot>/.ai-whisper/ralph/<workflowId>`) and add it to the render values in **both** kickoff render paths — the driver's first kickoff (`kickoffCurrentPhase`) and the loop re-kick inside `applyOrchestratorVerdict` (`kickoffNextPhaseInternal`). A registry/`renderTemplate` unit test alone is insufficient: an integration test must assert a real rendered kickoff contains the resolved path, not the literal `{ralphDir}` (§11).

## 6. Control-flow & verdict mechanics (Approach A)

Implemented by extending the existing verdict-application path (`applyOrchestratorVerdict` in `workflow-control.ts`); all new branches are gated on the current phase having a loop descriptor.

**No new evaluator verdict.** The evaluator emits only existing verdicts: `delivered` (implement/fix) and `approve` / `findings` / `escalate` (review). "Completion" is **not** an evaluator verdict — it is a **control mapping**: a review-step `approve` while the persisted `ralphCompletionClaim` flag is set terminates the workflow `done`. This is deliberately robust — the completion decision is gated by deterministic control state (the flag) plus the reviewer's acceptance approval, never by the evaluator re-deriving a `[[RALPH:GOAL-COMPLETE]]` marker it does not receive (see Marker propagation below). The completion outcome is observable via the workflow's `done` status and the acceptance-gate review handoff.

### 6.0 Per-item handoff protocol (the `delivered` hop)
The existing workflow protocol requires an implementer (`implement`/`fix`) handback to first normalize to **`delivered`**, which creates the reviewer (`review`) handoff; only the reviewer's handback yields `approve`/`findings`. Ralph follows that exact protocol — it must not start with `review` (no work would exist) nor let the evaluator approve an implementer handback directly (that would bypass the independent reviewer). One item therefore is:

1. **implement** (kickoff, or re-kick): implementer does the chunk, updates `PROGRESS.md`, commits, hands back ending with a ralph marker. Evaluator (ralph-loop, implementer step) → **`delivered`** → creates the `review` handoff.
2. **review**: reviewer judges. Evaluator (ralph-loop, reviewer step) → `approve` / `findings`. Control then maps a review `approve` to either **loop** (next item) or **workflow `done`** (completion), depending on the persisted `ralphCompletionClaim` flag (§6.1).
3. On `findings` → **fix**: implementer applies findings, appends a generalizable lesson to `LEARNINGS.md`, hands back ending with a ralph marker. Evaluator → **`delivered`** → back to step 2. Capped by `maxRounds`.

#### Marker propagation (required — the marker must not depend on the LLM path)
The completion marker originates on the implementer's `implement`/`fix` handback, but the `delivered`→`review` continuation builds a fresh review prompt via `renderReviewRequestText` (`workflow-control.ts` ~lines 729/736) that does **not** carry the prior implementer handback, and the review-step evaluator input is the *reviewer's* reply — so the raw `[[RALPH:GOAL-COMPLETE]]` token would be lost. Therefore the implementation **must**, when applying the `delivered` verdict for a ralph looping phase:

1. **Detect the marker deterministically** in the implementer handback text (exact-token match) and **persist it** to `workflowContext` (e.g. `ralphCompletionClaim: boolean`). This persisted flag — not the in-band token — is the authoritative completion signal.
2. **Select the review-request text by that flag:** render the **acceptance-gate** review prompt when `ralphCompletionClaim` is set (instructs the reviewer to verify the whole goal against the acceptance criteria), and the **per-item** review prompt otherwise. This is how the reviewer (and thus the review-step evaluator) operates on the correct framing.

The reviewer-step verdict then resolves against the persisted flag (§6.1) — completion never depends on a marker surviving into the evaluator payload.

### 6.1 Verdict mechanics for a looping phase
- **`delivered`** (from an `implement`/`fix` step) → create the `review` handoff. Plus the ralph step from §6.0: **recompute** `ralphCompletionClaim` from the marker (set it to `true` iff the handback contains `[[RALPH:GOAL-COMPLETE]]`, else `false`) and select the acceptance-gate vs per-item review-request text by it. Because the flag is recomputed every `delivered`, it is always fresh at the next review — no separate "clear" step is needed (a rejected completion claim simply yields `false` on the next delivery).
- **`findings`** (from a `review` step) → existing behavior: spawn a `fix` continuation handoff back to the implementer; capped by `maxRounds`.
- **`approve`** (from a `review` step) → close the current chain + phase run, then branch on the persisted flag:
  - **`ralphCompletionClaim` set → workflow `done`** (this is "completion": the reviewer approved an acceptance-gate review). This is the control mapping that replaces a `complete` evaluator verdict.
  - **otherwise → loop:** do **not** increment `currentPhaseIndex`; increment `workflowContext.ralphIteration`; if `ralphIteration >= maxIterations`, halt (§10); otherwise begin a new phase run for the **same** phase index (next item, an `implement` kickoff) with a fresh chain and a freshly rendered kickoff.
- **Inner escalation** (chain reaches `maxRounds` without approval) → existing escalation path halts the workflow (§10).

The iteration counter and any completion bookkeeping live in `workflowContext` (JSON) — **no schema migration is required.**

### 6.2 Workspace setup at start
The run namespace must exist before the first kickoff is rendered: `<workspace>/.ai-whisper/ralph/<workflowId>/` and `<workspace>/.ai-whisper/.gitignore` (`*`).

**Exact hook + ordering.** `createWorkflow` inserts the workflow row and **immediately** emits `workflow.created` (`packages/broker/src/control/workflow-control.ts` ~lines 117/142), and the driver kicks off on that event — so setup performed "after createWorkflow" would race the kickoff. Therefore setup runs **inside the driver's `kickoffCurrentPhase`, before rendering the kickoff text**, for `ralph-loop` workflows only. It is **idempotent** (safe under the driver's resume/sweep re-entry): create-dir-if-absent, write-`.gitignore`-if-absent. The driver already has the collab's `workspaceRoot` and already performs workspace fs work (HEAD reads), so this fits there.

**Failure behavior.** If setup fails (fs error — unwritable workspace, etc.), the driver **halts the workflow** with a clear reason (e.g. `ralph setup failed: <error>`), mirroring the existing `failed to read workspace HEAD` halt path. It does not kick off into a half-set-up state.

### 6.3 Required type/plumbing changes (the `ralph-loop` key + control mapping)
There is **no new evaluator verdict** (§6 intro). The work is: thread the `ralph-loop` prompt key through every type site, and add the control-side marker/loop handling.

- **Prompt key union — widen everywhere it appears, or typecheck fails.** The key is typed as `"review-loop" | "execution-gate"` (sometimes `| null`) in all of: `packages/cli/src/runtime/relay-orchestrator-evaluator.ts` (~line 52, `WorkflowEvaluatorInput`); `packages/broker/src/runtime/workflow-registry.ts` (`PhaseConfig`); `packages/cli/src/runtime/evaluator-observer.ts` (~lines 24 and 29); `packages/broker/src/storage/repositories/relay-evaluator-diagnostics-repository.ts` (~line 18); `packages/broker/src/control/create-control-service.ts` (~line 1223). Add `"ralph-loop"` to each.
- **Orchestrator key selection** (`relay-orchestrator.ts` ~line 165): resolve the phase's configured key from the workflow definition by `phaseName` (§5.3) rather than the `handoffStep`-only derivation.
- **`selectBranch`** (`relay-orchestrator-evaluator.ts` ~line 312): dispatch `ralph-loop` exactly like `review-loop` (by `handoffStep`: `delivered` branch for implement/fix, `review` branch for review). No new schema or branch.
- **Marker detection + review-prompt selection** (`applyOrchestratorVerdict`, the `delivered` branch, ralph looping phase only): exact-token-match the implementer handback for `[[RALPH:GOAL-COMPLETE]]`, persist `workflowContext.ralphCompletionClaim` (recomputed each delivery), and select the acceptance-gate vs per-item `renderReviewRequestText` variant from that flag (§6.0). This deterministic control state — not the in-band token — is the authoritative completion signal.
- **Loop verdict application** (`applyOrchestratorVerdict`, the `approve` branch, ralph looping phase only): map a review `approve` to workflow `done` when `ralphCompletionClaim` is set, else re-kick the same phase (iteration++ / `maxIterations` cap). Set the existing `action` (`workflow-done` / `workflow-halted` / `phase-advanced`) and **fall through to the shared emission-assembly block** (it builds `chain.resolved` / `workflow.phase-done` / `workflow.done` / `workflow.halted` from `action`) — do not `return` early, or terminal events are lost.
- **SDD safety:** every widened union keeps its existing members and every new branch is gated on the `ralph-loop` key / loop descriptor, so spec-driven-development takes the unchanged path.

## 7. Evaluator prompt (`ralph-loop`)

A new evaluator prompt key. It branches **first on the handoff step** (which agent handed back), then on the implementer's exact marker (§5.4):

**Implementer step (`implement` / `fix`)** — the implementer just handed back work:
- Return **`delivered`** if the handback is substantive work (it ends with `[[RALPH:ITEM-DELIVERED]]` or `[[RALPH:GOAL-COMPLETE]]`) → routes to the reviewer (§6.0). This is the only non-terminal route; it never approves/completes an implementer handback directly, preserving the independent reviewer.
- Return **`escalate`** only for non-delivery (a question, refusal, or empty reply), matching SDD's non-delivery handling.

**Reviewer step (`review`)** — the evaluator uses the existing `review` branch and returns only `approve` / `findings` / `escalate`. The acceptance-vs-item *framing* lives in the review-request prompt (selected control-side by the persisted `ralphCompletionClaim` flag, §6.0), so the reviewer reviews the right thing; the evaluator just classifies the reviewer's reply:
- **Per-item review** (flag unset): the reviewer judged a chunk → classify `approve` (acceptable) or `findings`. Control then loops to the next item.
- **Acceptance-gate review** (flag set): the reviewer verified the whole goal → classify `approve` (criteria met) or `findings` (gaps). Control maps a flag-set `approve` to workflow `done` (§6.1) — the completion outcome.

There is no `complete` evaluator verdict; completion is the control mapping `review approve + ralphCompletionClaim`. A stray approval can never complete an ordinary item because the flag is unset there.

As with SDD, verdicts must lead with the outcome and justify it in at least two substantive sentences.

## 8. CLI surface & defaults

- Start: `whisper workflow start --type ralph-loop --spec <goal-file>` (plus optional `--implementer` / `--reviewer` / `--name`).
- The evaluator preflight shipped in the evaluator-configuration feature applies automatically (a misconfigured evaluator bails before kickoff).
- `whisper collab dashboard` is the inspection surface during a run (verdict history, per-item rounds, cost).

## 9. Schema impact

**None.** The iteration counter and completion bookkeeping live in the existing `workflows.workflowContext` JSON. No migration, no new column.

## 10. Error handling & exits

- **Completion** (review `approve` while `ralphCompletionClaim` is set) → workflow `done`.
- **Inner escalation** (an item cannot pass review within `maxRounds`) → **halt the entire workflow** with a clear reason. Rationale: one item burning the review budget signals a structural problem (too-large chunk, ambiguous goal, or a genuinely hard blocker); halting for a human is cheaper than grinding.
- **Outer cap** (`ralphIteration >= maxIterations`) → halt with reason `ralph loop hit maxIterations cap (<N>) without completion`.
- **Evaluator unavailable / unconfigured** → existing preflight + workflow-halt behavior (from the evaluator-configuration feature).
- **Unknown workflow type / missing bindings** → existing driver halt paths, unchanged.

## 11. Testing strategy

- **Unit (registry):** `ralph-loop` definition exists with a loop descriptor (`repeatUntilComplete`, `maxIterations`), the `ralph-loop` evaluator key, and the chunk-sizing kickoff text; `renderTemplate` substitutes `{ralphDir}`.
- **Unit/integration (prompt-key plumbing):** the phase's configured `evaluatorPromptKey` reaches the orchestrator — assert a `ralph-loop` phase yields the `ralph-loop` key (not the `handoffStep`-derived default), and an SDD phase still yields its existing key. `selectBranch` dispatches `ralph-loop` to the delivered/review branches.
- **Unit (marker detection + persistence):** applying `delivered` for a ralph implement/fix handback containing `[[RALPH:GOAL-COMPLETE]]` sets `workflowContext.ralphCompletionClaim`; one with `[[RALPH:ITEM-DELIVERED]]` (or no marker) leaves it unset; the acceptance-gate vs per-item review-request text is selected accordingly (exact tokens asserted).
- **Control (`applyOrchestratorVerdict`):**
  - looping-phase review `approve` with the flag **unset** → same `currentPhaseIndex`, a new phase run, `ralphIteration` incremented, and the terminal/loop events emitted (no early return);
  - review `approve` with the flag **set** → workflow `done` (the completion mapping);
  - `findings` → `fix` continuation (unchanged); the flag is recomputed (not separately cleared) on the next delivery;
  - inner escalation → workflow halted;
  - `ralphIteration` reaching `maxIterations` → workflow halted with the cap reason.
- **Integration (`{ralphDir}` real render):** a real kickoff (not just `renderTemplate` in isolation) contains the resolved `<workspaceRoot>/.ai-whisper/ralph/<workflowId>` path, not the literal `{ralphDir}` — covering both the first kickoff and the loop re-kick.
- **Integration (setup):** the driver creates `.ai-whisper/ralph/<workflowId>/` + `.ai-whisper/.gitignore` (`*`) before the first kickoff, idempotently; a setup fs failure halts the workflow with a clear reason; the user's root `.gitignore` is untouched.
- **Integration (full loop):** a real broker driven through k items (`delivered` with `[[RALPH:ITEM-DELIVERED]]` → review `approve` → loop) then a completion cycle (`delivered` with `[[RALPH:GOAL-COMPLETE]]` → acceptance review `approve`) reaches `done`; assert per-item phase runs at the same index and the terminal events. A separate run hitting inner escalation halts.
- **Regression:** all existing SDD workflow tests stay green (no loop descriptor → existing advance/finish path).

## 12. Acceptance criteria

1. A `ralph-loop` workflow on a multi-item goal runs item → review → (fix)\* → approve repeatedly, re-kicking the same phase per item without advancing a phase index.
2. The implementer maintains `PROGRESS.md` and appends generalizable corrections to `LEARNINGS.md` under `<workspace>/.ai-whisper/ralph/<workflowId>/`, and re-orients from them each item.
3. ai-whisper writes only inside `<workspace>/.ai-whisper/`, self-ignores it via `.ai-whisper/.gitignore` (`*`), and never edits the user's tracked files; the implementer auto-commits work per item, excluding the bookkeeping.
4. The workflow terminates `done` on reviewer-confirmed completion (a review `approve` while the completion-claim flag is set — the acceptance gate), halts on inner escalation, and halts on the outer `maxIterations` cap.
5. No schema migration is introduced; iteration/completion state lives in `workflowContext`.
6. spec-driven-development behavior is unchanged (regression tests green).

## 13. Open questions / future work

- **True fresh-context reset.** v1 uses a soft reset (re-orient-from-files instructions + the agent's own context compaction). A future mode could genuinely reset the mounted agent's session each iteration for the full anti-drift benefit; the durable `LEARNINGS.md` already makes a hard reset safe. The design keeps memory in files specifically so this can be added without redesign.
- **Reviewer-optional / periodic-review mode.** A config knob to skip per-item review (final/periodic gate only) for cheaper runs.
- **Dedicated `/ralph` skill** mirroring `ai-whisper-sdd` (readiness preflight + kickoff + exit).
- **Per-run retention / cleanup** of `.ai-whisper/ralph/<workflowId>/` directories over time.
