export interface WorkflowCancelDeps {
	broker: {
		control: {
			cancelWorkflow: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

// cancelWorkflow is synchronous; async wrapper kept so callers can uniformly
// await workflow commands and catch thrown errors via Promise rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowCancel(deps: WorkflowCancelDeps): Promise<void> {
	deps.broker.control.cancelWorkflow({ workflowId: deps.workflowId, now: deps.now });
}
