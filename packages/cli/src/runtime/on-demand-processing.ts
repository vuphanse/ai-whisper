import { createCompanionRuntime } from "@ai-whisper/companion-core";
import type { BrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider } from "@ai-whisper/shared";

export async function processOneTurn(input: {
	broker: BrokerRuntime;
	collabId: string;
	sessionId: string;
	provider: CompanionProvider;
	now: string;
}) {
	const companion = createCompanionRuntime({
		broker: input.broker,
		collabId: input.collabId,
		sessionId: input.sessionId,
		provider: input.provider,
	});
	companion.register(input.now);
	return companion.processNext(input.now);
}
