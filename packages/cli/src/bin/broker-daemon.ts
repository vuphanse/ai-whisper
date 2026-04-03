#!/usr/bin/env node
/**
 * Broker daemon process — spawned by `whisper collab start`.
 * Reads config from environment variables, opens the broker,
 * starts the HTTP listener, and stays alive.
 */
import { createBrokerRuntime } from "@ai-whisper/broker";

const sqlitePath = process.env.AI_WHISPER_BROKER_SQLITE!;
const host = process.env.AI_WHISPER_BROKER_HOST ?? "127.0.0.1";
const port = Number(process.env.AI_WHISPER_BROKER_PORT ?? "4311");

const broker = createBrokerRuntime({ sqlitePath, host, port });

await broker.start();

function shutdown(): void {
	void broker.stop().then(() => {
		process.exit(0);
	});
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
