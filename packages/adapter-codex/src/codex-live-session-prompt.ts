import type { ProviderWorkRequest } from "@ai-whisper/shared";
import { beginBrokerReply, endBrokerReply } from "@ai-whisper/shared";
import { buildCodexPrompt } from "./codex-prompt.js";

export function buildCodexInteractiveBrokerPrompt(request: ProviderWorkRequest) {
	return [
		`Print exactly this line first: ${beginBrokerReply(request.workItemId)}`,
		"Then print ONLY the JSON reply object.",
		`Then print exactly this line last: ${endBrokerReply(request.workItemId)}`,
		"",
		buildCodexPrompt(request),
	].join("\n");
}
