import { getWorkflowDefinition } from "@ai-whisper/broker";

export interface WorkflowStartDeps {
	broker: {
		control: {
			createWorkflow: (input: {
				collabId: string;
				workflowType: string;
				name?: string;
				specPath: string;
				roleBindings: { implementer: "claude" | "codex"; reviewer: "claude" | "codex" };
				now: string;
			}) => { workflowId: string };
		};
	};
	collabId: string;
	workflowType: string;
	specPath: string;
	implementer?: "claude" | "codex";
	reviewer?: "claude" | "codex";
	name?: string;
	now: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowStart(deps: WorkflowStartDeps): Promise<{ workflowId: string }> {
	const def = getWorkflowDefinition(deps.workflowType);
	const implementer = deps.implementer ?? def?.defaultImplementer;
	const reviewer = deps.reviewer ?? def?.defaultReviewer;
	if (!implementer || !reviewer) {
		throw new Error(
			`Workflow type "${deps.workflowType}" has no default role bindings. Pass --implementer and --reviewer explicitly.`,
		);
	}
	return deps.broker.control.createWorkflow({
		collabId: deps.collabId,
		workflowType: deps.workflowType,
		specPath: deps.specPath,
		roleBindings: { implementer, reviewer },
		...(deps.name ? { name: deps.name } : {}),
		now: deps.now,
	});
}
