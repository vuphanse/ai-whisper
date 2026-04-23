export interface WorkflowCancelDeps {
	broker: {
		control: {
			cancelWorkflow: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

export async function runWorkflowCancel(deps: WorkflowCancelDeps): Promise<void> {
	deps.broker.control.cancelWorkflow({ workflowId: deps.workflowId, now: deps.now });
}
