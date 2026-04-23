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
	implementer: "claude" | "codex";
	reviewer: "claude" | "codex";
	name?: string;
	now: string;
}

export async function runWorkflowStart(deps: WorkflowStartDeps): Promise<{ workflowId: string }> {
	return deps.broker.control.createWorkflow({
		collabId: deps.collabId,
		workflowType: deps.workflowType,
		specPath: deps.specPath,
		roleBindings: { implementer: deps.implementer, reviewer: deps.reviewer },
		...(deps.name ? { name: deps.name } : {}),
		now: deps.now,
	});
}
