export type HandoffStep = "review" | "fix" | "implement" | "execute";

export type ArtifactKind = "spec" | "plan" | "commit-range";

export interface PhaseConfig {
	name: string;
	implementerRole: "implementer";
	reviewerRole: "reviewer" | null;
	maxRounds: number;
	initialHandoffStep: HandoffStep;
	kickoffTemplate: string;
	stepTemplates: Partial<Record<HandoffStep, string>>;
	evaluatorPromptKey: "review-loop" | "execution-gate";
	artifactOut: { kind: ArtifactKind; pathTemplate?: string };
}

export interface WorkflowDefinition {
	type: string;
	displayName: string;
	description: string;
	phases: PhaseConfig[];
}

export const SPEC_DRIVEN_DEVELOPMENT: WorkflowDefinition = {
	type: "spec-driven-development",
	displayName: "Spec-Driven Development",
	description: "Spec refining → plan writing → execution → code review",
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

const REGISTRY: Record<string, WorkflowDefinition> = {
	[SPEC_DRIVEN_DEVELOPMENT.type]: SPEC_DRIVEN_DEVELOPMENT,
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
