import type { ProviderWorkRequest } from "@ai-whisper/shared";
import { beginBrokerReply, endBrokerReply } from "@ai-whisper/shared";

export function buildClaudeInteractiveBrokerPrompt(request: ProviderWorkRequest) {
	return `Reply with exactly three lines and nothing else. Line 1: ${beginBrokerReply(request.workItemId)} Line 2: one compact JSON object like {"kind":"answer","content":"...","transitionIntent":"completed"} Line 3: ${endBrokerReply(request.workItemId)} action=${request.requestedAction} instruction=${request.instruction}`;
}
