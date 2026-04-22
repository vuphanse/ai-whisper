export type HandoffStep = "review" | "fix" | "implement" | "execute";

export interface PhaseConfig {
	name: string;
	implementerRole: "implementer";
	reviewerRole: "reviewer" | null;
	maxRounds: number;
	initialHandoffStep: HandoffStep;
	kickoffTemplate: string;
	stepTemplates: Partial<Record<HandoffStep, string>>;
	evaluatorPromptKey: "review-loop" | "execution-gate";
	artifactOut: { kind: string; pathTemplate?: string };
}

export interface WorkflowDefinition {
	type: string;
	displayName: string;
	description: string;
	phases: PhaseConfig[];
}

export const SUPERPOWERS_FEATURE_DEVELOPMENT: WorkflowDefinition = {
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
			kickoffTemplate:
				"Review the spec at {specPath}. Approve or list findings.",
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
				review:
					"Review the implementation plan at {planPath}. Approve or list findings.",
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
};

const REGISTRY: Record<string, WorkflowDefinition> = {
	[SUPERPOWERS_FEATURE_DEVELOPMENT.type]: SUPERPOWERS_FEATURE_DEVELOPMENT,
};

export function getWorkflowDefinition(
	type: string,
): WorkflowDefinition | undefined {
	return REGISTRY[type];
}

export function listWorkflowTypes(): string[] {
	return Object.keys(REGISTRY);
}

export function renderTemplate(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key) =>
		Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
	);
}

export function derivePlanPath(specPath: string, dateIso: string): string {
	const basename = specPath.split("/").pop() ?? "plan.md";
	const withoutExt = basename.replace(/\.md$/, "");
	const slug = withoutExt
		.replace(/-design$/, "")
		.replace(/^\d{4}-\d{2}-\d{2}-/, "");
	const date = dateIso.slice(0, 10);
	return `docs/superpowers/plans/${date}-${slug}.md`;
}
