import type { ProviderWorkRequest } from "@ai-whisper/shared";

export function buildCodexPrompt(request: ProviderWorkRequest): string {
	return [
		"Return ONLY valid JSON.",
		"{",
		'  "kind": "answer" | "review" | "clarification" | "failure",',
		'  "content": "string",',
		'  "transitionIntent": "in_progress" | "awaiting_user" | "completed" | "failed" | null',
		"}",
		"",
		`action: ${request.requestedAction}`,
		`instruction: ${request.instruction}`,
		`collabId: ${request.collabId}`,
		`threadId: ${request.threadId}`,
		`workItemId: ${request.workItemId}`,
	].join("\n");
}
