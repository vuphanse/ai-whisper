import { join } from "node:path";

export type HandoffStep = "review" | "fix" | "implement" | "execute";

export type ReviewMode = "chunk-review" | "phase-review" | "acceptance-review";

export type ArtifactKind = "spec" | "plan" | "commit-range";

export const RALPH_ITEM_DELIVERED_MARKER = "[[RALPH:ITEM-DELIVERED]]";
export const RALPH_GOAL_COMPLETE_MARKER = "[[RALPH:GOAL-COMPLETE]]";

export interface PhaseConfig {
	name: string;
	implementerRole: "implementer";
	reviewerRole: "reviewer" | null;
	maxRounds: number;
	initialHandoffStep: HandoffStep;
	kickoffTemplate: string;
	stepTemplates: Partial<Record<HandoffStep, string>>;
	evaluatorPromptKey: "review-loop" | "execution-gate" | "ralph-loop";
	artifactOut: { kind: ArtifactKind; pathTemplate?: string };
	repeatUntilComplete?: boolean;
	maxIterations?: number;
	/** Review-request template used when the implementer claims the goal is complete. */
	acceptanceReviewTemplate?: string;
	/** Review mode for this phase's normal review step. Acceptance reviews always use "acceptance-review". */
	reviewMode?: ReviewMode;
}

export interface WorkflowDefinition {
	type: string;
	displayName: string;
	description: string;
	phases: PhaseConfig[];
	defaultImplementer?: "claude" | "codex";
	defaultReviewer?: "claude" | "codex";
}

export const WORKFLOW_REVIEW_PROTOCOL = `--- ai-whisper workflow review protocol ---
You are the gatekeeper for an ai-whisper autonomous workflow review gate (reviewMode: {reviewMode}). No human is in the loop. Follow this protocol before returning a verdict.

Review mode semantics:
- chunk-review: judge ONLY the current delivered chunk against the relevant goal/procedure slice; the whole goal need not be complete.
- phase-review: judge the current phase output against the phase contract and relevant spec/plan requirements; future phases need not be complete.
- acceptance-review: judge the FULL deliverable against the full contract and acceptance criteria.

Required procedure:
1. Build an acceptance matrix and PRINT it. One row per requirement/criterion relevant to this gate: Requirement | Required evidence | Implementation evidence | Test/verification evidence | Pass/Fail. Do not collapse into a broad "looks good". Approval requires every row to pass.
2. Tests are deliverables: if the contract requires a test/guard/fixture/verification, inspect the committed test itself — does it check the exact condition and the correct layer? Would the required regression still slip through while it passes? Watch exactness words (exactly, same, both, after build, no code changes, guard, must). Green output does NOT replace required committed coverage.
3. Adversarial pass: assume the implementation is subtly incomplete; try to make each gate criterion fail. Tie every candidate blocking finding to an exact contract item; if it cannot be tied, do not report it as blocking (record it as a non-blocking risk if it is still useful quality signal).

Severity:
- Blocking ONLY if it prevents THIS gate from validly passing (criteria violation, contract contradiction, required verification failure, required test that does not test the specified condition/layer, forbidden change, or behavior that breaks the spec). Name the exact contract item for every blocking finding.
- Do NOT block on style/naming, optional refactors, extra non-required tests, future-phase concerns, or (in chunk-review) whole-goal incompleteness. Suppress style/taste entirely.

Missing context: if an input REQUIRED FOR THIS MODE is absent, you are blocked — do not approve and do not file a fixable finding (the implementer cannot supply review context). Signal that you CANNOT PROCEED so the gate ESCALATES and halts.

Never reply with only a single word or a bare verdict; your full reply (matrix + verdict) must be well over 100 characters.

Output format — the verdict line MUST come before the Non-blocking risks section, which is always LAST:
Review matrix:
| Requirement | Evidence | Test/verification evidence | Result |
| ... |

Findings:           (omit this block entirely if none)
- <blocking finding tied to an exact contract item, with file/line or command evidence>

<verdict line: "Approved. <one or two sentences>" OR, when blocked/cannot-proceed, state you cannot proceed and why>

Non-blocking risks:
- <quality risk that does NOT block this gate, or "None.">
--- end protocol ---`;

const SDD_SPEC_REVIEW =
	"Review the spec at {specPath}. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

const SDD_CODE_REVIEW =
	"Review commits {commitRange} against the spec's acceptance criteria, and run the project's verification/tests. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

export const SPEC_DRIVEN_DEVELOPMENT: WorkflowDefinition = {
	type: "spec-driven-development",
	displayName: "Spec-Driven Development",
	description: "Spec refining → plan writing → execution → code review",
	defaultImplementer: "claude" as const,
	defaultReviewer: "codex" as const,
	phases: [
		{
			name: "spec-refining",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "review",
			kickoffTemplate: SDD_SPEC_REVIEW,
			stepTemplates: {
				review: SDD_SPEC_REVIEW,
				fix: "Apply the reviewer's findings to {specPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected spec; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "phase-review",
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
				"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			stepTemplates: {
				implement:
					"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
				review:
					"Review the implementation plan at {planPath} against the spec's acceptance criteria. This is an autonomous workflow with no human in the loop.\n\n" +
					WORKFLOW_REVIEW_PROTOCOL,
				fix: "Apply the reviewer's findings to {planPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected plan; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "phase-review",
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
				"Execute the plan at {planPath} now: make all changes it specifies, run the verification command the plan or spec defines and ensure it passes, then commit. This is an autonomous workflow — no human will respond. Do the work yourself; never ask for confirmation, permission, or clarification. Hand back the commit SHAs and the verification output, plus a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			stepTemplates: {
				execute:
					"Execute the plan at {planPath} now: make all changes it specifies, run the verification command the plan or spec defines and ensure it passes, then commit. This is an autonomous workflow — no human will respond. Do the work yourself; never ask for confirmation, permission, or clarification. Hand back the commit SHAs and the verification output, plus a 1-2 sentence summary; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
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
			kickoffTemplate: SDD_CODE_REVIEW,
			stepTemplates: {
				review: SDD_CODE_REVIEW,
				fix: "Apply the reviewer's findings to commits {commitRange} now (amend or add commits as needed). This is an autonomous workflow — no human will respond. Do the work yourself and hand back the updated commit SHAs and verification output; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
			reviewMode: "acceptance-review",
			evaluatorPromptKey: "review-loop",
			artifactOut: { kind: "commit-range" },
		},
	],
};

const RALPH_KICKOFF = `You are running an autonomous ralph loop against the goal at {specPath}. No human is in the loop — never ask for confirmation, permission, or clarification; do the work yourself.

Run directory (your durable memory; already created): {ralphDir}
- {ralphDir}/PROGRESS.md — the work ledger (done / in-progress / remaining). Create it if absent. If the goal file contains an explicit checklist, copy it in on this first item.
- {ralphDir}/LEARNINGS.md — generalizable corrections to avoid repeating mistakes. Create it if absent. Re-read it every item.

Each turn:
1. Read the goal ({specPath}), PROGRESS.md, and LEARNINGS.md as ground truth (re-orient from these, not from prior conversation).
2. Pick the next unfinished chunk. Size it as the smallest independently-verifiable unit of real progress (e.g. one file, one endpoint, one bug) — small enough to finish and pass review in a single round; if a chunk fails review twice, split it. Honor any granularity the goal file specifies.
3. Do the work, update PROGRESS.md, and commit your code changes (do NOT commit {ralphDir} — it is gitignored).
4. End your handback with a 1-2 sentence summary, then on its own final line the exact marker [[RALPH:ITEM-DELIVERED]].

If PROGRESS.md and the repo show NO remaining work, do not invent more: end your handback with a 1-2 sentence completion summary, then on its own final line the exact marker [[RALPH:GOAL-COMPLETE]] instead.

Your reply must be at least two sentences, well over 100 characters — never hand back only a single word.`;

const RALPH_FIX = `Apply the reviewer's findings now. This is an autonomous workflow — no human will respond. Make the changes yourself; never ask for confirmation, permission, or clarification.

Also append any GENERALIZABLE lesson from these findings (a mistake likely to recur on other items — "pattern X breaks Y -> do Z") to {ralphDir}/LEARNINGS.md; skip one-off typos. Update PROGRESS.md and commit your code changes (not {ralphDir}).

End your handback with a 1-2 sentence summary, then on its own final line the exact marker [[RALPH:ITEM-DELIVERED]]. Your reply must be at least two sentences, well over 100 characters.`;

const RALPH_ITEM_REVIEW =
	"Review the latest delivered chunk against the goal at {specPath}. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

const RALPH_ACCEPTANCE_REVIEW =
	"The implementer claims the ENTIRE goal at {specPath} is complete. Verify the goal's completion/acceptance criteria against the current repository state. This is an autonomous workflow with no human in the loop.\n\n" +
	WORKFLOW_REVIEW_PROTOCOL;

export const RALPH_LOOP: WorkflowDefinition = {
	type: "ralph-loop",
	displayName: "Ralph Loop",
	description:
		"Gated self-loop: grind an open-ended goal chunk-by-chunk until a reviewer confirms completion",
	defaultImplementer: "claude" as const,
	defaultReviewer: "codex" as const,
	phases: [
		{
			name: "ralph-iteration",
			implementerRole: "implementer",
			reviewerRole: "reviewer",
			maxRounds: 5,
			initialHandoffStep: "implement",
			kickoffTemplate: RALPH_KICKOFF,
			stepTemplates: {
				implement: RALPH_KICKOFF,
				fix: RALPH_FIX,
				review: RALPH_ITEM_REVIEW,
			},
			acceptanceReviewTemplate: RALPH_ACCEPTANCE_REVIEW,
			reviewMode: "chunk-review",
			evaluatorPromptKey: "ralph-loop",
			repeatUntilComplete: true,
			maxIterations: 100,
			artifactOut: { kind: "commit-range" },
		},
	],
};

const REGISTRY: Record<string, WorkflowDefinition> = {
	[SPEC_DRIVEN_DEVELOPMENT.type]: SPEC_DRIVEN_DEVELOPMENT,
	[RALPH_LOOP.type]: RALPH_LOOP,
};

export function ralphRunDir(workspaceRoot: string, workflowId: string): string {
	return join(workspaceRoot, ".ai-whisper", "ralph", workflowId);
}

export function getWorkflowDefinition(
	type: string,
): WorkflowDefinition | undefined {
	return REGISTRY[type];
}

export function listWorkflowTypes(): string[] {
	return Object.keys(REGISTRY);
}

/**
 * Substitute `{key}` placeholders in `template` with `values[key]`.
 * Unknown keys are left literal so callers can layer partial renders.
 * Single-pass: values containing `{key}`-like text are NOT re-rendered.
 */
export function renderTemplate(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match: string, key: string) =>
		Object.prototype.hasOwnProperty.call(values, key)
			? (values[key] ?? match)
			: match,
	);
}

/**
 * Derive a plan file path from a design spec path.
 *
 * Expects `specPath` to end with `-design.md` (optionally prefixed with `YYYY-MM-DD-`).
 * Expects `dateIso` to start with `YYYY-MM-DD`.
 * Throws on inputs that don't match these shapes — callers should sanitize first.
 */
export function derivePlanPath(specPath: string, dateIso: string): string {
	if (!/^\d{4}-\d{2}-\d{2}/.test(dateIso)) {
		throw new Error(
			`derivePlanPath: dateIso must start with YYYY-MM-DD, got "${dateIso}"`,
		);
	}
	const basename = specPath.split("/").pop() ?? "";
	if (!basename.endsWith("-design.md")) {
		throw new Error(
			`derivePlanPath: specPath must end with "-design.md", got "${specPath}"`,
		);
	}
	const withoutExt = basename.replace(/\.md$/, "");
	const slug = withoutExt
		.replace(/-design$/, "")
		.replace(/^\d{4}-\d{2}-\d{2}-/, "");
	const date = dateIso.slice(0, 10);
	return `docs/superpowers/plans/${date}-${slug}.md`;
}
