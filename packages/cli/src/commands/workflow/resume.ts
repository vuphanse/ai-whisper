export interface WorkflowResumeDeps {
	broker: {
		control: {
			resumeWorkflow: (input: { workflowId: string; now: string }) => void;
		};
	};
	workflowId: string;
	now: string;
}

export async function runWorkflowResume(deps: WorkflowResumeDeps): Promise<void> {
	deps.broker.control.resumeWorkflow({ workflowId: deps.workflowId, now: deps.now });
}
