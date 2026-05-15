#!/usr/bin/env node
import { runCollabRelayMonitor } from "../commands/collab/relay-monitor.js";

const cwd = process.env.AI_WHISPER_WORKSPACE_ROOT ?? process.cwd();

const sqlitePath = process.env.AI_WHISPER_BROKER_SQLITE;
const host = process.env.AI_WHISPER_BROKER_HOST;
const portStr = process.env.AI_WHISPER_BROKER_PORT;
const collabId = process.env.AI_WHISPER_COLLAB_ID;
const brokerEnv =
	sqlitePath && host && portStr && collabId
		? { sqlitePath, host, port: Number(portStr), collabId }
		: undefined;

runCollabRelayMonitor({ cwd, ...(brokerEnv ? { brokerEnv } : {}) }).catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
