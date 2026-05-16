#!/usr/bin/env node
/**
 * Broker daemon process — spawned by `whisper collab start`.
 * Reads config from environment variables, opens the broker,
 * starts the HTTP listener, and stays alive.
 */
import { loadDotEnv } from "../runtime/load-dot-env.js";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createRelayOrchestrator } from "../runtime/relay-orchestrator.js";
import {
	createRelayOrchestratorEvaluator,
	type EvaluatorProviderConfig,
} from "../runtime/relay-orchestrator-evaluator.js";
import { buildEvaluatorObserverCallback } from "../runtime/evaluator-observer.js";
import { writeOwnPidToBrokerDaemon } from "../runtime/process-start-time.js";
import { execFile } from "node:child_process";

loadDotEnv();

const sqlitePath = process.env.AI_WHISPER_BROKER_SQLITE!;
const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");
const collabId = process.env.AI_WHISPER_COLLAB_ID!;

const broker = createBrokerRuntime({ sqlitePath, host, port });

if (collabId) {
	writeOwnPidToBrokerDaemon(broker.db, {
		collabId,
		now: new Date().toISOString(),
	});
}

await broker.start();

function buildProviderConfig(provider: "anthropic" | "ollama"): EvaluatorProviderConfig {
	if (provider === "anthropic") {
		return { provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY! };
	}
	return {
		provider: "ollama",
		...(process.env.AI_WHISPER_EVALUATOR_OLLAMA_HOST !== undefined
			? { host: process.env.AI_WHISPER_EVALUATOR_OLLAMA_HOST }
			: {}),
		...(process.env.AI_WHISPER_EVALUATOR_OLLAMA_MODEL !== undefined
			? { model: process.env.AI_WHISPER_EVALUATOR_OLLAMA_MODEL }
			: {}),
	};
}

const collab = broker.control.getCollab(collabId);

const evaluator = (() => {
	if (!collab?.orchestratorEnabled) return null;
	const rawProvider = process.env.AI_WHISPER_EVALUATOR_PROVIDER ?? "anthropic";
	const primary = buildProviderConfig(rawProvider === "ollama" ? "ollama" : "anthropic");
	const rawFallback = process.env.AI_WHISPER_EVALUATOR_FALLBACK;
	const fallback =
		rawFallback === "anthropic" || rawFallback === "ollama"
			? buildProviderConfig(rawFallback)
			: undefined;
	return createRelayOrchestratorEvaluator({
		primary,
		...(fallback !== undefined ? { fallback } : {}),
		onCall: buildEvaluatorObserverCallback({ broker }),
	});
})();

async function readWorkspaceHead(cId: string): Promise<string> {
	const workspaceRoot = broker.control.getCollab(cId)?.workspaceRoot;
	if (!workspaceRoot) {
		throw new Error(`readWorkspaceHead: no workspaceRoot for collab ${cId}`);
	}
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", workspaceRoot, "rev-parse", "HEAD"],
			(err, stdout) => {
				if (err) reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
				else resolve(stdout.trim());
			},
		);
	});
}

const orchestrator =
	collab?.orchestratorEnabled && evaluator
		? createRelayOrchestrator({ broker, collabId, evaluate: evaluator, readWorkspaceHead })
		: null;

orchestrator?.start();

async function shutdown(): Promise<void> {
	orchestrator?.stop();
	await broker.stop();
	process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
