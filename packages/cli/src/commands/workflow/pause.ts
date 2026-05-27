export interface WorkflowPauseDeps {
	broker: {
		control: {
			pauseWorkflow: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

// pauseWorkflow is synchronous; async wrapper kept so callers can uniformly
// await workflow commands and catch thrown errors via Promise rejection.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowPause(deps: WorkflowPauseDeps): Promise<void> {
	deps.broker.control.pauseWorkflow({ workflowId: deps.workflowId, now: deps.now });
}
