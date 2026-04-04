#!/usr/bin/env node
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createLiveSessionRuntime } from "../runtime/live-session.js";
import { runCompanionAgentLoop } from "../runtime/companion-agent-loop.js";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
} from "../runtime/providers.js";
import {
	enqueueRelayWork,
	formatRelayAcknowledgement,
	formatRelayReplySummary,
} from "../runtime/relay-service.js";
import { waitForReply } from "../runtime/reply-wait.js";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

async function main(): Promise<void> {
	const agentArg = process.argv[2];
	if (agentArg !== "codex" && agentArg !== "claude") {
		throw new Error(
			"companion-agent requires a target argument: codex or claude",
		);
	}

	const sqlitePath = requireEnv("AI_WHISPER_BROKER_SQLITE");
	const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
	const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");
	const collabId = requireEnv("AI_WHISPER_COLLAB_ID");
	const sessionId = requireEnv("AI_WHISPER_SESSION_ID");

	const broker = createBrokerRuntime({
		sqlitePath,
		host,
		port,
	});
	const provider = createProviderForTarget(agentArg);
	const interactiveSession = createInteractiveSessionForTarget({
		target: agentArg,
		cwd: process.cwd(),
		stdout: process.stdout,
	});
	const liveSession = createLiveSessionRuntime({
		interactiveSession,
		stdin: process.stdin,
		stdout: process.stdout,
		onRelay: async (directive, sendNow) => {
			const relay = enqueueRelayWork({
				broker,
				collabId,
				originSessionId: sessionId,
				target: directive.target,
				instruction: directive.instruction,
				artifactPaths: [],
				forceNewThread: directive.forceNewThread,
				now: new Date().toISOString(),
			});

			sendNow(
				`${formatRelayAcknowledgement({
					target: directive.target,
					createdNewThread: relay.createdNewThread,
				})}\n`,
			);

			const reply = await waitForReply({
				broker,
				threadId: relay.thread.threadId,
				workItemId: relay.workItem.workItemId,
			});

			return `${formatRelayReplySummary({
				target: directive.target,
				replyKind: reply.kind,
				content: reply.content,
			})}\n`;
		},
	});

	let stopLoop = async () => {};
	let liveSessionStarted = false;
	let stopping = false;
	let requestExit!: () => void;
	const exitRequested = new Promise<void>((resolve) => {
		requestExit = resolve;
	});

	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		requestExit();
	};

	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	try {
		await liveSession.start();
		liveSessionStarted = true;
		stopLoop = await runCompanionAgentLoop({
			broker,
			collabId,
			sessionId,
			provider,
			interactiveSession,
		});
		await exitRequested;
	} finally {
		await stopLoop();
		if (liveSessionStarted) {
			await liveSession.stop();
		}
		await broker.stop();
	}
}

await main();
