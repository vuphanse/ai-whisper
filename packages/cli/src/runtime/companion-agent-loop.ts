import { createCompanionRuntime } from "@ai-whisper/companion-core";
import type { BrokerRuntime } from "@ai-whisper/broker";
import type {
	CompanionProvider,
	InteractiveSessionController,
} from "@ai-whisper/shared";
import { createBrokerArtifactService } from "./broker-artifact-service.js";
import { createLiveSessionBrokerExecutor } from "./live-session-broker-executor.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runCompanionAgentLoop(input: {
	broker: BrokerRuntime;
	collabId: string;
	sessionId: string;
	provider: CompanionProvider;
	interactiveSession: InteractiveSessionController;
	pollIntervalMs?: number;
}): Promise<() => Promise<void>> {
	input.provider.attachInteractiveSession?.(input.interactiveSession);

	const artifactService = createBrokerArtifactService();
	const executor = createLiveSessionBrokerExecutor({
		provider: input.provider,
		artifactService,
		sessionId: input.sessionId,
	});

	artifactService.sweep();

	const companion = createCompanionRuntime({
		broker: input.broker,
		collabId: input.collabId,
		sessionId: input.sessionId,
		provider: input.provider,
		executor,
	});

	companion.register(new Date().toISOString());
	let stopping = false;
	let loopDoneResolve!: () => void;
	const loopDone = new Promise<void>((resolve) => {
		loopDoneResolve = resolve;
	});

	void (async () => {
		let lastHeartbeatAt = 0;
		while (!stopping) {
			const now = Date.now();
			if (now - lastHeartbeatAt >= 1000) {
				companion.heartbeat(new Date(now).toISOString());
				lastHeartbeatAt = now;
			}
			await companion.processNext(new Date().toISOString());
			await sleep(input.pollIntervalMs ?? 25);
		}
		loopDoneResolve();
	})();

	return Promise.resolve(async () => {
		stopping = true;
		await loopDone;
	});
}
