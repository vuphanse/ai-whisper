export type HandoffStep = "review" | "fix" | "implement" | "execute";

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
}

export interface WorkflowDefinition {
	type: string;
	displayName: string;
	description: string;
	phases: PhaseConfig[];
	defaultImplementer?: "claude" | "codex";
	defaultReviewer?: "claude" | "codex";
}

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
			kickoffTemplate:
				"Review the spec at {specPath}. This is an autonomous workflow with no human in the loop. Reply 'Approved' if the spec is internally consistent and implementable against its own acceptance criteria. Return findings ONLY for concrete, blocking defects (contradictions, or violations of the spec's own acceptance criteria); do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead your reply with the verdict ('Approved' or 'Findings: ...'), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.",
			stepTemplates: {
				review:
					"Review the spec at {specPath}. This is an autonomous workflow with no human in the loop. Reply 'Approved' if the spec is internally consistent and implementable against its own acceptance criteria. Return findings ONLY for concrete, blocking defects (contradictions, or violations of the spec's own acceptance criteria); do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead your reply with the verdict ('Approved' or 'Findings: ...'), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.",
				fix: "Apply the reviewer's findings to {specPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected spec; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
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
				"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			stepTemplates: {
				implement:
					"Using the approved spec at {specPath}, write a complete implementation plan to {planPath}, then hand back. This is an autonomous workflow — no human will respond. Do the work yourself now; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you wrote; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
				review:
					"Review the implementation plan at {planPath} against the spec's acceptance criteria. This is an autonomous workflow with no human in the loop. Reply 'Approved' if the plan would satisfy those acceptance criteria. Return findings ONLY for concrete, blocking violations of the acceptance criteria; do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead your reply with the verdict ('Approved' or 'Findings: ...'), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.",
				fix: "Apply the reviewer's findings to {planPath} now. This is an autonomous workflow — no human will respond. Make the edits yourself and hand back the corrected plan; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
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
			kickoffTemplate:
				"Review commits {commitRange} against the spec's acceptance criteria, and run the project's verification/tests. This is an autonomous workflow with no human in the loop. Reply 'Approved' if the acceptance criteria are met and verification passes. Return findings ONLY for concrete, blocking violations of the acceptance criteria; do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead your reply with the verdict ('Approved' or 'Findings: ...'), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.",
			stepTemplates: {
				review:
					"Review commits {commitRange} against the spec's acceptance criteria, and run the project's verification/tests. This is an autonomous workflow with no human in the loop. Reply 'Approved' if the acceptance criteria are met and verification passes. Return findings ONLY for concrete, blocking violations of the acceptance criteria; do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead your reply with the verdict ('Approved' or 'Findings: ...'), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.",
				fix: "Apply the reviewer's findings to commits {commitRange} now (amend or add commits as needed). This is an autonomous workflow — no human will respond. Do the work yourself and hand back the updated commit SHAs and verification output; never ask for confirmation, permission, or clarification. End your handback with a 1-2 sentence summary of what you changed; your reply must be at least two sentences, well over 100 characters — never hand back only a single word.",
			},
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
	"Review the latest delivered chunk against the goal at {specPath}. This is an autonomous workflow with no human in the loop. Reply \"Approved\" if the chunk is a correct, complete unit of progress consistent with the goal. Return findings ONLY for concrete, blocking defects; do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead with the verdict (\"Approved\" or \"Findings: ...\"), then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.";

const RALPH_ACCEPTANCE_REVIEW =
	"The implementer claims the ENTIRE goal at {specPath} is complete. This is an autonomous workflow with no human in the loop. Verify the goal's completion/acceptance criteria against the current repository state. Reply \"Approved\" if every criterion is met. Otherwise return \"Findings: ...\" naming the specific remaining gaps (these become the next items). Do not raise stylistic, scope, or speculative concerns, and do not ask questions. Lead with the verdict, then justify it; your full reply must be at least two sentences, well over 100 characters — never reply with only a single word or a bare verdict.";

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
