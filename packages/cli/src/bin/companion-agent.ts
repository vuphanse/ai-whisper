#!/usr/bin/env node
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createCompanionRuntime } from "@ai-whisper/companion-core";
import { createProviderForTarget } from "../runtime/providers.js";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function main(): Promise<void> {
	const agentArg = process.argv[2];
	if (agentArg !== "codex" && agentArg !== "claude") {
		throw new Error("companion-agent requires a target argument: codex or claude");
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
	const companion = createCompanionRuntime({
		broker,
		collabId,
		sessionId,
		provider: createProviderForTarget(agentArg),
	});

	let stopping = false;
	const shutdown = () => {
		stopping = true;
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	companion.register(new Date().toISOString());
	let lastHeartbeatAt = 0;

	try {
		while (!stopping) {
			const now = Date.now();
			if (now - lastHeartbeatAt >= 1000) {
				companion.heartbeat(new Date(now).toISOString());
				lastHeartbeatAt = now;
			}

			const reply = await companion.processNext(new Date().toISOString());
			await sleep(reply ? 25 : 250);
		}
	} finally {
		await broker.stop();
	}
}

await main();
