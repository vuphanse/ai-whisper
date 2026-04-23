import { listWorkflowTypes } from "@ai-whisper/broker";

export async function runWorkflowTypes(): Promise<string[]> {
	return listWorkflowTypes();
}
