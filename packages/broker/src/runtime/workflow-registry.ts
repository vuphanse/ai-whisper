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
				"Review the spec at {specPath}. Approve or list findings.",
			stepTemplates: {
				review: "Review the spec at {specPath}. Approve or list findings.",
				fix: "Address the reviewer's findings in {specPath}.",
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
				review:
					"Review the implementation plan at {planPath}. Approve or list findings.",
				fix: "Address the reviewer's findings in {planPath}.",
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
				fix: "Address the reviewer's findings on commits {commitRange}.",
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
