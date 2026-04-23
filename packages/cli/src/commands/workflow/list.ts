export interface WorkflowListDeps {
	broker: {
		control: {
			listWorkflows: (filter: { collabId?: string }) => unknown[];
		};
	};
	collabId?: string;
}

export async function runWorkflowList(deps: WorkflowListDeps): Promise<unknown[]> {
	const filter: { collabId?: string } = {};
	if (deps.collabId !== undefined) {
		filter.collabId = deps.collabId;
	}
	return deps.broker.control.listWorkflows(filter);
}
