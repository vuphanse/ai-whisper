import { listWorkflowTypes } from "@ai-whisper/broker";

// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowTypes(): Promise<string[]> {
	return listWorkflowTypes();
}
