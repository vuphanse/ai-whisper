# Complex Bug-Fixing Workflow — Design Spec

**Branch:** spec/complex-bug-fixing-workflow
**Status:** approved design, pre-plan

## Summary

Add `complex-bug-fixing`, a third bundled workflow alongside `spec-driven-development`
and `ralph-loop`. It is a fixed three-phase pipeline that takes a **bug report** and
drives it to a verified fix through gated, adversarial review:

1. **diagnosis** — the implementer reproduces the bug themselves, then writes a
   diagnosis artifact (root cause + proposed fix + blast radius + residual risks).
   The reviewer challenges it hard; the gate stays shut until both agree on the cause
   and that the fix is net-safe.
2. **fix-and-verify** — the implementer applies the approved fix, turns the
   reproduction GREEN, and verifies across the declared blast radius. The reviewer
   does an adversarial acceptance review including test-coverage adequacy.
3. **post-mortem** — the implementer writes a final report (cause, fix, coverage gaps,
   residual risks, lessons learned) so nothing slips silently; the reviewer confirms
   it faithfully reflects the run.

The diagnosis and post-mortem are **self-verification artifacts for the human reviewer
after the run**, not repository knowledge — teams keep that kind of record on their own
platforms (Jira, Notion, Favro). They therefore live in a **gitignored workflow run dir**
(`.ai-whisper/bugfix/<workflowId>/`), mirroring ralph's run dir; only the fix and the
reproduction test are committed to the repo.

The point of the workflow is to make *complex* bug fixing rigorous: the expensive
mistake on a hard bug is a confident wrong fix. A gated diagnosis forces the cause to
be **proven by an observed reproduction** (not speculated from reading code paths)
before any code changes, and an adversarial reviewer prevents whack-a-mole symptom
patching.

## Motivation

ai-whisper ships two workflows: `spec-driven-development` (specifiable deliverable up
front) and `ralph-loop` (open-ended goal ground down chunk-by-chunk). Neither fits the
"a bug was reported, root cause unknown, fix it correctly" shape:

- SDD assumes you can describe "done" up front. For a complex bug you cannot — the
  whole point is that the cause is unknown until investigated.
- Ralph is for long-horizon, many-chunk goals. A single bug fix is one deliverable
  with a hard correctness bar, not a checklist to burn down.

The missing workflow is a short, high-rigor pipeline whose discipline is **reproduce →
prove the cause → agree on a safe fix → fix and verify → record what happened**.

## Non-goals

- Not a general "improve the code" workflow — it is scoped to fixing one reported bug.
- No new evaluator prompt key and no new evaluator credentials: all phases reuse the
  existing `review-loop` evaluator routing (`done` / `loop` / `escalate`).
- No change to the public behavior of `spec-driven-development` or `ralph-loop`. The
  engine change in this spec (§ Engine change) must be strictly additive and covered by
  a regression test.

## Input artifact

A **bug report** file (markdown or plain text) describing symptoms, reproduction steps,
and expected-vs-actual behavior. Passed via the existing `--spec=<path>` flag, reusing
the `{specPath}` template placeholder. A bug report implies a human (dev or QA) already
observed and reproduced the bug, so the implementer is expected to reproduce it too.

## Architecture

The workflow is a `WorkflowDefinition` registered in
`packages/broker/src/runtime/workflow-registry.ts`, identical machinery to the existing
two: an implementer and a reviewer take turns, the LLM evaluator gates each handback,
and the role the run is triggered from becomes the implementer.

```
diagnosis ──approve──▶ fix-and-verify ──approve──▶ post-mortem ──approve──▶ done
   │                        │                          │
findings→fix loop       findings→fix loop          findings→fix loop
   │                        │                          │
escalate (halt)         escalate (halt)            escalate (halt)
```

### Phase table

| Phase | initialHandoffStep | reviewerRole | reviewMode | evaluatorPromptKey | maxRounds | artifactOut |
|---|---|---|---|---|---|---|
| `diagnosis` | `implement` | reviewer | `phase-review` | `review-loop` | 5 | `{ kind: "spec", pathTemplate: "{diagnosisPath}" }` |
| `fix-and-verify` | `implement` | reviewer | `acceptance-review` | `review-loop` | 5 | `{ kind: "commit-range" }` |
| `post-mortem` | `implement` | reviewer | `phase-review` | `review-loop` | 3 | `{ kind: "spec", pathTemplate: "{postmortemPath}" }` |

`{diagnosisPath}` and `{postmortemPath}` resolve to files inside the gitignored run dir
(`{bugfixDir}/diagnosis.md`, `{bugfixDir}/postmortem.md`) — see § Run dir & path helpers.

All three phases lead with `implement`: the implementer authors the phase's artifact
first (the diagnosis artifact does not pre-exist the way an SDD spec does), then the
reviewer reviews. This matches SDD's `plan-writing` phase shape (sender = reviewer,
target = implementer on the kickoff; see `kickoffNextPhaseInternal`).

`defaultImplementer: "claude"`, `defaultReviewer: "codex"` — same default pairing as the
other two workflows; roles follow the caller when started from a mounted session.

## Phase 1 — diagnosis

### Implementer produces (the diagnosis artifact, written to `{diagnosisPath}`)

- **Reproduction** — an *actually observed* reproduction the implementer ran themselves.
  - A **failing test (RED)**, committed in this phase, is strongly preferred — failing for
    the right reason. It is committed here (not deferred) so it survives handoffs and
    review rounds; the base anchored at workflow start keeps it inside the later
    `fix-and-verify` review range (see § Engine change).
  - Best-effort real reproduction otherwise: e2e, or real-browser automation (e.g.
    Playwright) when the project's infra supports it.
  - If no automated test can capture it (genuine concurrency/environment cases),
    command/log output is acceptable **with an explicit justification** in the artifact.
  - Speculation from reading code paths is **not** a valid reproduction.
- **Root cause** — the causal chain symptom→cause, each link backed by concrete evidence
  (stack trace, log line, failing assertion, bisect), not assertion.
- **Proposed fix approach** — what will change and *why that removes the root cause*
  rather than masking the symptom.
- **Blast radius** — every area/module/contract the proposed fix could affect.
- **Residual risks** — foreseeable risks that remain after the fix.

### Reviewer — adversarial diagnosis gate

Phase 1's reviewer uses a dedicated `WORKFLOW_DIAGNOSIS_PROTOCOL` (not the generic
`WORKFLOW_REVIEW_PROTOCOL`). The gate stays shut until the reviewer *independently*
agrees — not until the implementer sounds convincing. Required procedure:

1. **Independently reproduce** — re-run the reproduction yourself; do not trust pasted
   output. If you cannot reproduce it, that is a blocking finding (the repro is not
   real/reliable).
2. **Attack the causal claim** — is the cause *proven* by the evidence chain, or merely
   asserted? Could the named cause be a correlate, or a symptom of something deeper?
   Demand any missing link.
3. **Attack the fix (anti-whack-a-mole)** — does it remove the root cause, or just this
   symptom's surface? Could the bug resurface through another path? Name it if so.
4. **Attack the blast radius** — is it complete? Add what is missing.
5. **Attack residual risks** — are the real risks named, or hand-waved?
6. **Mutual-agreement gate** — approve **only** when you have independently confirmed the
   reproduction and agree the cause is proven and the fix is net-safe (fixes more than it
   risks). "Plausible" is not approval.

**Severity & risk channel** (consistent with the existing `WORKFLOW_REVIEW_PROTOCOL` and
the project's quality-first review policy): a blocking finding must tie to a concrete
diagnosis-contract item — unreproducible repro, an unproven causal link, a
symptom-masking fix, an incomplete blast radius, or un-named foreseeable risk. Suppress
style/taste. **But do not gag valuable non-contract risk signals** — surface them in a
`Non-blocking risks:` section (last, as in the generic protocol) so they reach the human
at escalation/completion rather than being lost. Blocking ≠ gagging: name the risk even
when it does not block the gate.

Routing (existing machinery): blocking findings → `loop` back to the implementer's `fix`
step (revise the artifact, re-handoff); `escalate` only when genuinely un-reviewable
(e.g. reproduction inputs truly absent and not the implementer's to supply) or round
budget exhausted.

`WORKFLOW_DIAGNOSIS_PROTOCOL` is the canonical reviewer prompt fragment for this gate; the
bundled `ai-whisper-bugfix` skill is a kickoff wrapper only and must **not** duplicate the
protocol text (single source of truth).

## Phase 2 — fix-and-verify

Starts only after the diagnosis is approved. The implementer re-orients from the
**approved diagnosis artifact** (`{diagnosisPath}` in the run dir), the durable ground
truth — not chat history.

### Implementer (fix step)

- Implement the fix per the **approved** approach.
- Turn the reproduction **GREEN** — the failing test now passes for the right reason; if
  the repro was a non-test demonstration, re-run it and show the symptom is gone.
- Run the project's verification/test command **plus targeted checks across the declared
  blast radius**, including the full suite, to catch regressions.
- Commit the fix (the RED reproduction test was already committed in `diagnosis`; commit
  any additional happy-path/edge-case coverage tests here too). **Do not commit the run
  dir** (`{bugfixDir}` is gitignored, same instruction ralph gives for its run dir). Hand
  back commit SHAs + verification output + a 1–2 sentence summary.

### Reviewer — adversarial acceptance review

Built on `WORKFLOW_REVIEW_PROTOCOL` with `reviewMode: "acceptance-review"`, plus the
following bug-fix-specific requirements:

- **Independently re-run** the reproduction (now GREEN) and the verification suite — do
  not trust pasted output.
- Acceptance matrix against the *approved diagnosis*: root cause actually removed?
  reproduction passes for the right reason? every declared blast-radius area
  regression-free? residual risks handled or explicitly accepted?
- **Anti-whack-a-mole** carries over: confirm the fix removed the cause, did not just
  relocate the symptom.
- **Coverage adequacy** — confirm the fix has adequate tests: every happy path has ≥1
  covering test, and edge cases are covered. Any case that genuinely cannot be covered
  (complex test setup, environment) is **not** a silent pass — it must be explicitly
  noted and carried into the post-mortem. A thin-coverage fix is a blocking finding.

### Cause-was-wrong guard

If, while fixing, the implementer discovers the approved cause was wrong, it must **not**
silently pivot to a different fix — the cause was the agreed premise of the run. It
escalates (or the reviewer blocks) so the diagnosis is re-opened with the human in the
loop, rather than letting a second, unreviewed theory slip in. This preserves
"mutual agreement on cause."

## Phase 3 — post-mortem

### Implementer produces (the post-mortem report, written to `{postmortemPath}`)

A final report recapping:

- Confirmed root cause.
- The fix applied.
- Reproduction→GREEN evidence.
- Blast radius touched.
- **Coverage gaps** explicitly listed (carried from phase 2).
- Residual risks.
- Lessons learned.

### Reviewer (phase-review)

Confirm the report faithfully reflects what actually happened — cause, fix, the noted
coverage gaps, and residual risks are all present and honest. This is not a rubber stamp;
gloss-overs are findings.

## Engine change (A2) — commit-range anchoring for a review-loop fix phase

The acceptance reviewer needs `{commitRange}` to review the full fix diff.
`liveReviewCommitRange` resolves to `base..HEAD` only when `baseBeforeExecution` is set in
`workflowContext`. Today the engine sets it **only** for phases whose
`initialHandoffStep === "execute"` (`kickoffNextPhaseInternal`, and `beginPhaseRun`).
`fix-and-verify` is a review-loop (`implement` step), so without a change `commitRange`
falls back to bare `"HEAD"` and the reviewer would see only the tip commit.

**Change:** anchor `baseBeforeExecution = workspaceHeadSha` when *entering the first phase*
(`diagnosis`, i.e. the repo HEAD at workflow start), alongside the existing `execute`
anchoring branch. The base is captured early and consumed later: the `diagnosis` reviewer
does not use `{commitRange}`, but anchoring at the start means the `fix-and-verify`
acceptance range `base..HEAD` spans **everything the workflow committed** — the RED
reproduction test committed in `diagnosis` *and* the fix commits in `fix-and-verify`,
across all review rounds (the upper bound is live `HEAD`). Anchoring at `fix-and-verify`
entry instead would exclude the phase-1 RED test commit from the reviewed range, which is
wrong — the reviewer must see the test and the fix as one change set.

**Strictly additive — no regression to existing workflows.** The anchoring must be gated
so it fires only for this workflow's first phase and leaves the SDD and ralph code paths
byte-for-byte unchanged in behavior. Preferred trigger: a new opt-in flag on `PhaseConfig`
(e.g. `anchorCommitBaseOnEntry?: boolean`) set only on `complex-bug-fixing`'s `diagnosis`
phase — explicit and self-documenting. The broker's workflow-start path must supply
`workspaceHeadSha` for this first kickoff (it already supplies it for `execute` phases).
SDD's `execute`-anchored path and ralph's no-anchor path must be exercised by an
existing-behavior regression test that asserts their `commitRange` resolution is unchanged.

Note: the existing SHA-capture special-case keyed on `phase.name === "code-review"`
(in the `delivered` branch of `applyOrchestratorVerdict`) is **not** required for
`fix-and-verify`. The acceptance review only needs `liveReviewCommitRange`
(`base..HEAD`), which depends on the anchored base, not on captured SHA arrays. Capturing
`fix-and-verify` SHAs into `workflowContext` is optional polish, out of scope unless the
plan finds the dashboard needs it.

## Run dir & path helpers

Artifacts live in a gitignored per-workflow run dir, mirroring ralph exactly:

- New helper in `workflow-registry.ts`: `bugfixRunDir(workspaceRoot, workflowId)` →
  `join(workspaceRoot, ".ai-whisper", "bugfix", workflowId)`, the direct analogue of the
  existing `ralphRunDir`.
- The run dir is created at workflow start, the same way ralph's run dir is created before
  its kickoff (the plan resolves the exact call site; ralph's kickoff template already
  assumes "already created").
- `.ai-whisper/` is already gitignored at repo root (`.gitignore:2`), so
  `.ai-whisper/bugfix/<workflowId>/` is already covered — verified with `git check-ignore`.
  No gitignore change needed.

Three placeholders are plumbed into **both** template render sites in
`workflow-control.ts` (`kickoffNextPhaseInternal` and `renderReviewRequestText`, plus the
findings→fix render branch), exactly where `ralphDir` is already computed and rendered:

- `{bugfixDir}` → `bugfixRunDir(workspaceRoot, workflowId)`
- `{diagnosisPath}` → `{bugfixDir}/diagnosis.md`
- `{postmortemPath}` → `{bugfixDir}/postmortem.md`

Because the artifacts live in a dedicated dir, there is no collision risk with `{specPath}`
(the bug report), so no `safeDerivePlanPath`-style sibling-distinctness guard is needed.

## CLI & skill wrapper

- CLI: `whisper workflow start --type=complex-bug-fixing --spec=<bug-report>` works once
  the definition is registered (`createWorkflow` validates the type against the registry).
- New bundled skill `ai-whisper-bugfix` (`packages/cli/skills/ai-whisper-bugfix/SKILL.md`)
  triggered by `/aiw-bugfix <report>` (and `$aiw-bugfix`, "run bugfix on <path>", etc.).
  It mirrors `ai-whisper-ralph`'s shape exactly: resolve path → readiness check
  (`whisper collab status --json`, same gates) → `whisper workflow start
  --type=complex-bug-fixing --spec=<abs>` → print one line → exit (fire-and-forget; no
  polling/narration so broker idle detection is not blocked).

## Docs

- `docs/workflows.md` — add the third workflow to "the workflows at a glance", a
  "choosing the workflow" entry (reach for it when: a bug is reported, root cause unknown,
  and a correct, verified, non-regressing fix matters), and an "authoring a bug report"
  subsection (symptoms, repro steps, expected-vs-actual; the better the repro, the faster
  the diagnosis converges).
- `docs/evaluator-configuration.md` — update the bundled-workflows list from two to three.

(Per the existing follow-up memory, porting workflow-guide content to the landing page is
tracked separately and is out of scope here.)

## Testing

### Unit — registry (`test/`)
- `getWorkflowDefinition("complex-bug-fixing")` returns a definition with exactly three
  phases in order `diagnosis`, `fix-and-verify`, `post-mortem`, with the gates, roles,
  reviewModes, evaluatorPromptKeys, and maxRounds in the phase table.
- `listWorkflowTypes()` includes `"complex-bug-fixing"`.
- `bugfixRunDir(workspaceRoot, workflowId)` joins `workspaceRoot/.ai-whisper/bugfix/
  <workflowId>` (the analogue of the existing `ralphRunDir` test).

### Unit — template rendering
- Each phase's kickoff and review templates render with `{specPath}`, `{bugfixDir}`,
  `{diagnosisPath}`, `{postmortemPath}`, `{commitRange}`, `{reviewMode}` resolved (no
  stray `{placeholder}` left literal), with `{diagnosisPath}`/`{postmortemPath}` nested
  under `{bugfixDir}`.

### Unit — diagnosis protocol is canonical and not duplicated (committed guards)
These lock the central contract from § Phase 1 (the diagnosis gate uses a *dedicated*
adversarial protocol, defined in exactly one place). Without them an implementation could
ship the generic `WORKFLOW_REVIEW_PROTOCOL` for diagnosis, or copy stale protocol text
into the skill, and still pass every other test.

- **Diagnosis review uses the dedicated protocol:** the `diagnosis` phase's **review**
  template (the reviewer-facing one) embeds `WORKFLOW_DIAGNOSIS_PROTOCOL` and does **not**
  embed the generic `WORKFLOW_REVIEW_PROTOCOL`. Conversely, `fix-and-verify`'s acceptance
  (review) template embeds `WORKFLOW_REVIEW_PROTOCOL` (assert both, so the two protocols
  cannot be swapped).
- **Protocol stays in the reviewer layer:** the `diagnosis` **findings→fix** template
  (implementer-facing — it tells the implementer to revise the artifact) does **not** embed
  `WORKFLOW_DIAGNOSIS_PROTOCOL`. The protocol is a reviewer prompt fragment; the gate
  obligations (independent reproduce, mutual-agreement approval, etc.) must never leak into
  the implementer's fix prompt.
- **Protocol content contract:** `WORKFLOW_DIAGNOSIS_PROTOCOL` contains the required
  obligations — independent reproduction by the reviewer, attacking the causal claim,
  anti-whack-a-mole challenge of the fix, blast-radius completeness, residual-risk
  challenge, the mutual-agreement approval gate, and the non-blocking risk channel.
  (Assert via stable marker substrings for each obligation, so deleting an obligation
  fails the test.)
- **Single source of truth (no skill duplication):** a guard that
  `packages/cli/skills/ai-whisper-bugfix/SKILL.md` does **not** contain the protocol text
  (assert the skill file shares no distinctive protocol marker substring with
  `WORKFLOW_DIAGNOSIS_PROTOCOL`) — the skill is a kickoff wrapper only.

### Integration — control (`test/`, mirroring the existing SDD/ralph control tests)
- Happy path: seed a collab + bound agents, start the workflow, drive
  approve→approve→approve and assert phase progression `diagnosis → fix-and-verify →
  post-mortem → done`.
- `findings` in any phase loops back to a `fix` step in the same phase (no premature
  advance).
- `escalate` / max-rounds in any phase halts the workflow.
- **Commit-range anchoring:** on workflow start (entry to `diagnosis`),
  `baseBeforeExecution` is set from the workspace head, and the `fix-and-verify` acceptance
  reviewer's rendered request contains `base..HEAD` (not bare `HEAD`) — the range spans
  the phase-1 RED test commit and the phase-2 fix commits.
- **Regression guard (the hard constraint):** an SDD run still anchors its base via the
  `plan-execution` `execute` path and resolves `commitRange` exactly as before, and a
  ralph run still resolves with no base anchoring — the new branch does not alter either.

### Edge cases to cover (and where)
- Run dir is gitignored → the fix commit does not accidentally include
  `.ai-whisper/bugfix/<workflowId>/` artifacts (assert via the `do not commit run dir`
  instruction + an ignore check).
- Implementer hands back a one-word/empty reply → existing non-delivery handling escalates
  (covered by existing engine behavior; assert it still holds for the new phases).
- `fix-and-verify` acceptance review when the implementer made multiple fix-round commits
  → reviewer's `base..HEAD` includes all of them (integration; this is the A2 payoff).
- Cause-was-wrong escalation: the implementer cannot silently swap theories — assert the
  workflow halts rather than advancing on an unreviewed second cause (integration, to the
  extent the harness can drive it; otherwise enforced via the prompt template + documented).

## Open questions

None outstanding — design approved through Section 4. The plan resolves the implementation
choice between the `anchorCommitBaseOnEntry` flag vs. derived trigger for the A2 engine
change (flag preferred).
