import { createCompanionRuntime } from "@ai-whisper/companion-core";
import type { BrokerRuntime } from "@ai-whisper/broker";
import type {
	CompanionProvider,
	InteractiveSessionController,
} from "@ai-whisper/shared";
import { createBrokerArtifactService } from "./broker-artifact-service.js";
import { createLiveSessionBrokerExecutor } from "./live-session-broker-executor.js";
import { formatRelayReplySummary } from "./relay-service.js";

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
	const sessionRole =
		input.broker.control
			.listSessions(input.collabId)
			.find((session) => session.sessionId === input.sessionId)?.agentType ??
		(input.provider.getIdentity().toolFamily === "codex" ? "codex" : "claude");

	const artifactService = createBrokerArtifactService();
	const baseExecutor = createLiveSessionBrokerExecutor({
		provider: input.provider,
		artifactService,
		sessionId: input.sessionId,
	});
	const executor = async (request: Parameters<typeof baseExecutor>[0]) => {
		input.interactiveSession.sendLocalMessage(
			`[ai-whisper] Received broker work for ${sessionRole}.\n`,
		);
		const reply = await baseExecutor(request);
		input.interactiveSession.sendLocalMessage(
			`${formatRelayReplySummary({
				target: sessionRole,
				replyKind: reply.kind,
				content: reply.content,
			})}\n`,
		);
		return reply;
	};

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
