# ai-whisper workflow review gate hardening - design

Date: 2026-05-22
Status: approved-for-planning

## Problem

ai-whisper autonomous workflows rely on an independent reviewer to keep quality
high while the implementer works without a human in the loop. The current review
prompt asks the reviewer to judge the deliverable against the spec's acceptance
criteria and return only blocking findings, but it does not force a concrete
review procedure or preserve useful quality risks that sit outside the current
contract.

The conformance gap can let a reviewer approve from a broad impression: the
implementation looks right, manual verification passes, and the full test suite
is green. This is not enough when an acceptance criterion requires a specific
committed guard test or exact behavior. A manual check can prove the current
artifact works, but it cannot substitute for required automated coverage that is
supposed to prevent future regressions.

There is a second quality gap: if review output is limited to only contract-tied
blocking findings, the reviewer is gagged from recording valuable risk signal
such as "this will likely break under concurrent X." That risk may not block the
current gate, but dropping it entirely optimizes for a quiet autonomous loop over
the quality bar ai-whisper is meant to protect.

The immediate failure mode: a reviewer approved a skill implementation even
though the spec required a guard test against the **post-build bundled skill
directory**, while the committed guard test only checked the source skill
directory. Build and manual install verification passed, but the committed guard
test did not satisfy the spec's own test requirement.

## Goal

Harden ai-whisper workflow review gates so reviewers make gate decisions from an
explicit contract matrix, inspect required tests as deliverables, surface
non-blocking quality risks without stalling the loop, and halt/escalate instead
of approving when required review context or verification is insufficient.

The design must work across workflows:
- SDD phase/final review.
- Ralph per-iteration review.
- Ralph final goal acceptance review.
- Future workflows such as bug-fixing.

## Non-goals

- A general-purpose user-facing code review feature.
- Dependence on Superpowers, bundled agent skills, or any third-party plugin
  skill.
- Blocking workflow progress on style, refactor, naming, or speculative findings
  that do not invalidate the current gate.
- Changing the implementer side of existing workflows.
- Replacing workflow-specific evaluator prompts entirely; this hardens the review
  protocol used at review gates.
- Solving weak specs entirely in implementation review. Acceptance criteria
  quality must also be reviewed during spec-refining gates, but final review can
  only enforce the contract it is given plus surface non-blocking risks.

## Design

### Canonical review prompt fragment

The orchestrator prompt fragment is the single source of truth for the workflow
review protocol. It is the only reliable channel in an autonomous relay handoff:
the reviewer always receives the handoff prompt, while local skill invocation is
environment-dependent.

The implementation should factor the review protocol into a shared prompt
fragment used by workflow review prompts. Tests should assert the fragment
contains the required modes, matrix instructions, test-fidelity rule,
non-blocking risk channel, and missing-context escalation rule.

### Evaluator-classifier compatibility

The control verdict (`approve | findings | escalate`) is not produced by the
reviewer agent directly. A separate evaluator — the neutral judge in
`relay-orchestrator-evaluator.ts` (`REVIEW_SYSTEM_PROMPT`) — reads the reviewer's
handback text and *classifies* it; it does not re-review the deliverable. The
quality protocol therefore lives in the reviewer prompt, but the new reviewer
output format must stay legible to that classifier or it will misroute.

Two concrete couplings:

1. **Risk channel must not be read as findings.** The reviewer now prints a
   `Non-blocking risks:` section under *both* approve and findings outputs. The
   classifier's standing rule is to prefer `findings` when uncertain, so an
   `Approved … Non-blocking risks: …` reply can be misclassified as `findings` and
   bounce the loop on the very channel this design adds. `REVIEW_SYSTEM_PROMPT`
   must be amended with one rule: a `Non-blocking risks` section is informational
   and does not, by itself, mean `findings`; classify on the verdict line and the
   `Findings:` section only.

2. **Blocked / missing-context must map to `escalate`.** The classifier already
   maps "the reviewer cannot proceed" to `escalate`. The reviewer prompt must use
   that signal (explicit blocked / cannot-proceed wording) for missing required
   context, so it halts rather than loops.

These are the only evaluator-side changes; the evaluator is otherwise untouched.

### Review modes

The orchestrator must pass or clearly state the review mode. The canonical prompt
fragment supports:

1. `chunk-review`

   Used for Ralph per-iteration review. The reviewer judges only the current
   claimed chunk against the relevant goal/procedure slice. The whole goal does
   not need to be complete.

2. `phase-review`

   Used for SDD-style phase gates or similar workflows. The reviewer judges the
   current phase output against the phase contract and relevant spec/plan
   requirements. Future phases do not need to be complete.

3. `acceptance-review`

   Used for final workflow completion. The reviewer judges the full deliverable
   against the full contract and acceptance criteria.

The same finding can have different severity by mode. For example, "the whole
goal is not complete" is not blocking in `chunk-review`, but is blocking in
`acceptance-review`.

### Review input contract

Every workflow review prompt should provide structured inputs:

- Review mode: `chunk-review`, `phase-review`, or `acceptance-review`.
- Workflow type: for example `spec-driven-development`, `ralph-loop`, or
  `bug-fixing`.
- Contract source(s): spec, goal, plan, procedure, or claimed chunk text.
- Deliverable: commit range, HEAD, files, handoff text, or phase output.
- Required verification: explicit commands or a repo/workflow rule for
  discovering them.
- Output policy: matrix plus verdict, blocking findings when present, and
  non-blocking quality risks when present.

If an input required *for the current review mode* is missing during an autonomous
workflow review gate, the reviewer must not approve. In autonomous mode it must not
ask a human for clarification. It must signal **blocked / cannot-proceed** so the
verdict resolves to `escalate` and the workflow **halts immediately**, rather than
emitting a `findings` verdict (which would loop the deliverable back to the
implementer to "fix" context it cannot supply) or moving forward from partial
evidence. Missing review context is an orchestrator-side gap, not an implementer
defect, so it must escalate — not loop. Scope this check to inputs the current mode
actually requires; do not block a legitimately sparse early gate for inputs a later
mode would need.

### Portable orchestrator prompt

The workflow prompt should be portable. It cannot assume a reviewer has
Superpowers or any external plugin installed.

At review gates, the orchestrator should say:

```text
You are reviewing an ai-whisper autonomous workflow gate. Follow the review
protocol below before returning a verdict.
```

The prompt then includes the canonical review protocol fragment inline. The
reviewer does not need a local skill or external plugin to complete the review.

### Spec-quality gate

The acceptance matrix is only as strong as the contract it receives. Therefore
review prompts used during spec-refining or plan-review gates must also apply this
protocol to the spec/plan itself:

- Are the acceptance criteria concrete enough to drive implementation review?
- Do they include required tests/guards at the right layer when quality depends on
  regression coverage?
- Are "done" and "must not regress" conditions explicit enough to review?
- Are known risks either handled by criteria or captured as non-blocking risks?

Weak acceptance criteria are blocking during spec/plan review. During final
implementation review, weak criteria discovered late should be surfaced as
non-blocking quality risks unless they also create a direct current-gate failure.

### Required review protocol

Before deciding, the reviewer builds an acceptance matrix and prints it in the
review output. This is intentional: auditability matters more than token cost in
workflow review gates.

For each explicit requirement or acceptance criterion relevant to the current
gate:
- Requirement / criterion.
- Required evidence.
- Implementation evidence.
- Test evidence, if applicable.
- Verification evidence, if applicable.
- Pass/fail.

The reviewer must not collapse multiple criteria into a broad "looks good"
judgment. Approval requires every current-gate matrix row to pass.

### Tests are deliverables

If the contract requires a test, guard, fixture, or verification step, the
reviewer must inspect the committed test itself.

The reviewer asks:
- Does the test check the exact condition required by the contract?
- Does it check the correct layer?
- Would the required regression still slip through while the test passes?
- Does the test cover exact wording such as `after build`, `both`, `same`, or
  `no code changes` when those words appear in the contract?

Manual verification and green test output can supplement confidence, but they do
not replace required committed automated coverage.

### Non-blocking quality risks

The reviewer may record non-blocking quality risks that do not invalidate the
current gate but are important quality signal. Examples:

- Concurrency, scale, or operational risks not covered by the current contract.
- Fragile assumptions that deserve a future criterion or follow-up.
- Security, data-loss, or reliability concerns that are plausible but not proven
  against the current deliverable.
- Spec weaknesses discovered during implementation review.

These risks do not block the gate by themselves. They are surfaced in the review
output, which is already persisted as relay-handoff text and is inspectable via
`whisper workflow inspect` — so they are visible at escalation/completion without a
new artifact or store. (Only add a dedicated risks store if a concrete consumer
later needs to read them programmatically.) If a risk later becomes concrete
evidence of contract failure, it is promoted to a blocking finding.

### Adversarial pass

Before approval, the reviewer performs one adversarial pass:

- Assume the implementation is subtly incomplete.
- Try to find how each current-gate criterion could still fail.
- Pay special attention to exactness words: `exactly`, `same`, `both`,
  `after build`, `no code changes`, `guard`, `must`.
- For every candidate finding, identify the exact requirement it blocks.

If a candidate finding cannot be tied to an explicit current-gate contract item,
it is not reported as a blocking finding. If it is still useful quality signal,
record it as a non-blocking risk.

### Severity policy

The review gate distinguishes blocking findings from non-blocking risks.

A finding is blocking only if it prevents the current workflow gate from validly
passing:

- Direct violation of the current gate's acceptance criteria or explicit
  requirements.
- Contradiction with the spec, goal, plan, or procedure.
- Required verification failure.
- Required test/guard exists but does not test the specified condition or layer.
- Change forbidden by the contract.
- Behavior that prevents the deliverable from working as specified.

The reviewer does not block on:

- Style, naming, or wording preferences.
- Optional refactors.
- Extra tests not required by the current contract.
- Future-phase concerns.
- Whole-goal incompleteness during `chunk-review`.

Style/taste comments are suppressed entirely. Plausible quality risks are
recorded only in the non-blocking risk channel, not as blockers.

For every reported finding, the reviewer must be able to name the exact contract
item or acceptance criterion it blocks.

### Exhaustion and escalation

This behavior **already holds at the control layer** and must be preserved, not
rebuilt: `workflow-control.ts` returns an `escalate` verdict when
`currentRound + 1 > maxRounds` (≈ lines 316-320), and a Ralph loop hitting
`maxIterations` halts (≈ lines 688-693). So when the gate cannot approve after the
allowed review/fix rounds, the workflow halts/escalates rather than silently
approving — that is current behavior.

The work here is to (a) add a guard test pinning that exhaustion → escalate/halt so
it cannot regress, and (b) ensure the escalation surfaces the review evidence. The
evidence does not need a new store: the reviewer's last reply — matrix, blocking
findings, non-blocking risks, verification — is already persisted as relay-handoff
text and is inspectable via `whisper workflow inspect`. No new mechanism is
required beyond the guard test.

This applies to both implementation gates and final acceptance gates. For Ralph,
inner-loop round exhaustion halts/escalates the current workflow rather than
accepting a chunk. For final acceptance review, exhaustion halts/escalates rather
than marking the goal complete.

### Output policy

Autonomous workflow review output is explicit and auditable.

If every current-gate requirement passes and verification passes:

```text
Review matrix:
| Requirement | Evidence | Test/verification evidence | Result |
| ... |

Non-blocking risks:
- <Risk, or "None.">

Approved. <Concise evidence summary.>
```

If the gate cannot pass:

```text
Review matrix:
| Requirement | Evidence | Test/verification evidence | Result |
| ... |

Findings:
- <Blocking finding tied to exact contract item, with file/line or command
  evidence.>

Non-blocking risks:
- <Risk, or "None.">
```

The reviewer does not ask questions in autonomous mode. Missing required context
is not a question and not a `findings` issue — it is a blocked / cannot-proceed
signal that resolves to `escalate` and halts the gate.

## Prompt audit matrix

| Area | Current prompt | Hardened prompt |
| --- | --- | --- |
| Role | Review against acceptance criteria. | Act as an ai-whisper workflow gatekeeper. |
| Scope | Inferred from wording. | Explicit `reviewMode`. |
| Context | Unstructured. | Workflow type, contract sources, deliverable, verification. |
| Protocol source | Plain prompt only. | Canonical orchestrator prompt fragment. |
| Criteria handling | Asked to review criteria. | Internal matrix for every current-gate criterion. |
| Evidence | Green checks can dominate. | Each criterion needs concrete evidence. |
| Tests | Run tests. | Review required tests for fidelity. |
| Manual checks | Can mentally compensate. | Supplement only; never replace required coverage. |
| Risk signal | Suppressed unless blocking. | Non-blocking quality risks are surfaced. |
| Severity | Blocking requested but underdefined. | Blocking tied to exact contract item; risks are separate. |
| Noise control | Non-blocking suppression requested. | Style/taste suppressed; quality risks recorded. |
| Adversarial pass | Not required. | Mandatory before approval. |
| Mode awareness | Not defined. | Chunk, phase, acceptance semantics differ. |
| Missing context | Undefined. | Blocked → `escalate`/halt, not `findings`/loop. |
| Evaluator coupling | Classifier may misread new output. | Risks = informational (not `findings`); blocked = `escalate`. |
| Output | Terse verdict. | Matrix plus verdict and risk channel. |

## Docs

README should not list a workflow-review skill, because no bundled review skill
ships. Documentation should state that workflow review gates embed the canonical
review protocol directly in the orchestrator handoff prompt.

## Tests

Prompt-text guard coverage:

- The orchestrator review prompt template includes or imports the canonical
  review prompt fragment.
- The canonical prompt fragment includes the three modes, required matrix output,
  test-fidelity review, non-blocking risk channel, missing-context escalation
  rule, and exhaustion/escalation rule.
- `REVIEW_SYSTEM_PROMPT` contains the rule that a `Non-blocking risks` section is
  informational and is not, by itself, classified as `findings`.
- Existing bundled skill packaging/install tests remain focused on actual
  user-invoked skills such as kickoff skills, not workflow review gates.

Behavioral guard coverage (the protocol's own thesis is that wording-level checks
are insufficient, so the load-bearing behaviors must be tested directly):

- **Risk-vs-findings classification:** an `Approved … Non-blocking risks: …`
  handback classifies as `approve`, not `findings` (no deadlock loop).
- **Missing-context → escalate:** a blocked / cannot-proceed handback classifies as
  `escalate` and halts, not `findings`/loop.
- **Exhaustion → escalate:** review/fix round exhaustion yields `escalate`/halt, not
  approve or silent continue (pins existing `workflow-control.ts` behavior).

Where prompt text becomes shared code, prefer tests against stable required
phrases rather than snapshotting the entire prompt.

## Acceptance criteria

1. A canonical workflow review prompt fragment exists and is used by workflow
   review prompts instead of duplicating the protocol across prompts or skills.
2. No bundled workflow-review skill is added; review gates rely on the inline
   canonical prompt fragment.
3. The canonical prompt defines `chunk-review`, `phase-review`, and
   `acceptance-review`, and explains the gate-specific blocking semantics for
   each.
4. Workflow review prompts include inline canonical protocol text that does not
   depend on external plugins.
5. The review protocol requires an acceptance matrix in the review output before
   approval.
6. The review protocol requires test-fidelity review for contract-required tests,
   guards, fixtures, or verification steps.
7. The review protocol requires one adversarial pass before approval.
8. Missing required review context (for the current mode) is defined as
   non-approval and resolves to `escalate`/halt — a blocked / cannot-proceed signal,
   not a `findings` issue that would loop the deliverable back to the implementer.
9. The severity policy reports blocking findings only when they block the current
   workflow gate, suppresses style/taste noise, and provides a non-blocking risk
   channel for useful quality risks outside the current contract.
10. Workflow round exhaustion halts/escalates with review evidence instead of
   approving, downgrading findings, or silently continuing. This already holds in
   `workflow-control.ts`; the criterion is satisfied by a guard test that pins it.
11. `REVIEW_SYSTEM_PROMPT` is updated so the evaluator classifies a
   `Non-blocking risks` section as informational (not `findings`) and maps a
   blocked / cannot-proceed handback to `escalate`.
12. Guard tests verify workflow review prompts include or import the canonical
   prompt fragment and that the fragment contains the required modes and quality
   rules; and behavioral tests verify risk-vs-findings classification,
   missing-context → escalate, and exhaustion → escalate.
13. Full repo verification remains green.

## Risks / edge cases

- **Over-blocking Ralph chunks** - handled by explicit `chunk-review` semantics:
  the whole goal need not be complete.
- **Under-blocking final acceptance** - handled by `acceptance-review`, which
  checks the full contract.
- **No external review skill installed** - irrelevant; the protocol is inline in
  the orchestrator prompt.
- **Reviewer noise** - controlled by the blocker/risk distinction: style is
  suppressed, useful risks are recorded but do not block.
- **Prompt drift** - guard tests assert stable required phrases/modes; the
  canonical prompt fragment avoids duplicate protocol sources.
- **Manual verification masking weak tests** - forbidden by the "tests are
  deliverables" rule.
- **Weak acceptance criteria** - blocked during spec/plan review; surfaced as
  non-blocking risk if discovered only at final implementation review.
- **Risk channel deadlocking the loop** - the evaluator classifier could read an
  approval-plus-risks reply as `findings` and re-loop; prevented by the
  `REVIEW_SYSTEM_PROMPT` rule that the risk section is informational, with a
  behavioral test.
- **Missing-context looping instead of halting** - prevented by routing
  blocked/cannot-proceed to `escalate` (not `findings`), with a behavioral test.
