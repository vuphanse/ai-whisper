import type { ProviderWorkRequest } from "@ai-whisper/shared";
import { beginBrokerReply, endBrokerReply } from "@ai-whisper/shared";
import { buildClaudePrompt } from "./claude-prompt.js";

export function buildClaudeInteractiveBrokerPrompt(request: ProviderWorkRequest) {
	return [
		`Print exactly this line first: ${beginBrokerReply(request.workItemId)}`,
		"Then print ONLY the JSON reply object.",
		`Then print exactly this line last: ${endBrokerReply(request.workItemId)}`,
		"",
		buildClaudePrompt(request),
	].join("\n");
}
