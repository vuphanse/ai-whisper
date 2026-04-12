#!/usr/bin/env node
/**
 * Broker daemon process — spawned by `whisper collab start`.
 * Reads config from environment variables, opens the broker,
 * starts the HTTP listener, and stays alive.
 */
import { loadDotEnv } from "../runtime/load-dot-env.js";
import { createBrokerRuntime } from "@ai-whisper/broker";

loadDotEnv();
import { createRelayOrchestrator } from "../runtime/relay-orchestrator.js";
import { createRelayOrchestratorEvaluator } from "../runtime/relay-orchestrator-evaluator.js";

const sqlitePath = process.env.AI_WHISPER_BROKER_SQLITE!;
const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");
const collabId = process.env.AI_WHISPER_COLLAB_ID!;

const broker = createBrokerRuntime({ sqlitePath, host, port });

await broker.start();

const collab = broker.control.getCollab(collabId);
const evaluator =
	collab?.orchestratorEnabled
		? createRelayOrchestratorEvaluator({
				apiKey: process.env.ANTHROPIC_API_KEY!,
		  })
		: null;
const orchestrator =
	collab?.orchestratorEnabled && evaluator
		? createRelayOrchestrator({ broker, collabId, evaluate: evaluator })
		: null;

orchestrator?.start();

async function shutdown(): Promise<void> {
	orchestrator?.stop();
	await broker.stop();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
