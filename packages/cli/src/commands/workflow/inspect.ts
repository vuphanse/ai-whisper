export interface WorkflowInspectDeps {
	broker: {
		control: {
			getWorkflow: (workflowId: string) => unknown | null;
			getWorkflowPhaseRuns: (workflowId: string) => unknown[];
		};
	};
	workflowId: string;
}

export async function runWorkflowInspect(
	deps: WorkflowInspectDeps,
): Promise<{ workflow: unknown; phaseRuns: unknown[] }> {
	const workflow = deps.broker.control.getWorkflow(deps.workflowId);
	if (!workflow) {
		throw new Error(`Workflow not found: ${deps.workflowId}`);
	}
	const phaseRuns = deps.broker.control.getWorkflowPhaseRuns(deps.workflowId);
	return { workflow, phaseRuns };
}
