import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createSessionId } from "@ai-whisper/shared";
import {
	createCliCollabId,
	createCliSessionId,
} from "../../runtime/id-factory.js";
import {
	launchSessions,
	type ExecFn,
	type LaunchMode,
	type SpawnFn,
} from "../../runtime/launcher.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import {
	readCliCollabState,
	writeCliCollabState,
} from "../../runtime/state-file.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const brokerDaemonPath = resolve(__dirname, "../../bin/broker-daemon.js");

function spawnBrokerDaemon(
	sqlitePath: string,
	host: string,
	port: number,
): number {
	const child = spawn("node", [brokerDaemonPath], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			AI_WHISPER_BROKER_SQLITE: sqlitePath,
			AI_WHISPER_BROKER_HOST: host,
			AI_WHISPER_BROKER_PORT: String(port),
		},
	});
	child.unref();
	return child.pid!;
}

export async function runCollabStart(input: {
	workspaceRoot: string;
	now: string;
	launchMode: LaunchMode;
	spawn?: SpawnFn;
	exec?: ExecFn;
	spawnBroker?: (sqlitePath: string, host: string, port: number) => number;
}) {
	const statePath = getStateFilePath(input.workspaceRoot);
	const existing = readCliCollabState(statePath);
	if (existing) {
		throw new Error(
			`A collab is already active (${existing.collabId}). Run \`whisper collab stop\` first.`,
		);
	}

	const sqlitePath = getBrokerSqlitePath(input.workspaceRoot);
	const brokerHost = "127.0.0.1";
	const brokerPort = 4311;
	mkdirSync(dirname(sqlitePath), { recursive: true });

	// Use in-process broker for initial setup (create collab, register sessions)
	const broker = createBrokerRuntime({
		sqlitePath,
		host: brokerHost,
		port: brokerPort,
	});

	const collabId = createCliCollabId(input.now);

	broker.control.startCollab({
		collabId,
		workspaceRoot: input.workspaceRoot,
		displayName: "phase5",
		now: input.now,
	});

	if (input.launchMode === "none") {
		// No sessions to register — close in-process broker and spawn daemon
		await broker.stop();

		const startBroker = input.spawnBroker ?? spawnBrokerDaemon;
		const brokerPid = startBroker(sqlitePath, brokerHost, brokerPort);

		writeCliCollabState(getStateFilePath(input.workspaceRoot), {
			version: 3,
			collabId,
			workspaceRoot: input.workspaceRoot,
			broker: {
				sqlitePath,
				host: brokerHost,
				port: brokerPort,
				pid: brokerPid,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: input.now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
		});
		return {
			collabId,
			launchMode: "none" as const,
			launched: false as const,
			brokerPid,
		};
	}

	const codexSessionId = createSessionId(
		createCliSessionId("codex", input.now),
	);
	const claudeSessionId = createSessionId(
		createCliSessionId("claude", input.now),
	);

	broker.control.registerSession({
		sessionId: codexSessionId,
		collabId,
		agentType: "codex",
		capabilities: { supportsDirectPackets: true },
		now: input.now,
	});

	broker.control.registerSession({
		sessionId: claudeSessionId,
		collabId,
		agentType: "claude",
		capabilities: { supportsDirectPackets: true },
		now: input.now,
	});

	broker.control.setSessionBinding({
		collabId,
		agentType: "codex",
		sessionId: codexSessionId,
		bindingSource: "launched",
		now: input.now,
	});

	broker.control.setSessionBinding({
		collabId,
		agentType: "claude",
		sessionId: claudeSessionId,
		bindingSource: "launched",
		now: input.now,
	});

	// Close in-process broker so the daemon can claim the SQLite file and port
	await broker.stop();

	// Spawn long-lived broker daemon
	const startBroker = input.spawnBroker ?? spawnBrokerDaemon;
	const brokerPid = startBroker(sqlitePath, brokerHost, brokerPort);

	const launch = launchSessions({
		launchMode: input.launchMode,
		collabId,
		workspaceRoot: input.workspaceRoot,
		brokerSqlitePath: sqlitePath,
		brokerHost,
		brokerPort,
		codexSessionId,
		claudeSessionId,
		...(input.spawn ? { spawn: input.spawn } : {}),
		...(input.exec ? { exec: input.exec } : {}),
	});

	writeCliCollabState(getStateFilePath(input.workspaceRoot), {
		version: 3,
		collabId,
		workspaceRoot: input.workspaceRoot,
		broker: {
			sqlitePath,
			host: brokerHost,
			port: brokerPort,
			pid: brokerPid,
		},
		launch: {
			mode: input.launchMode,
			...(launch.tmuxSession ? { tmuxSession: launch.tmuxSession } : {}),
		},
		ownedSessions: {
			codex: {
				sessionId: codexSessionId,
				providerId: "openai-codex-cli",
				launchMode: input.launchMode,
				...(launch.runtime.codexPid ? { pid: launch.runtime.codexPid } : {}),
				...(launch.runtime.codexWindowLabel
					? { windowLabel: launch.runtime.codexWindowLabel }
					: {}),
			},
			claude: {
				sessionId: claudeSessionId,
				providerId: "anthropic-claude-cli",
				launchMode: input.launchMode,
				...(launch.runtime.claudePid ? { pid: launch.runtime.claudePid } : {}),
				...(launch.runtime.claudeWindowLabel
					? { windowLabel: launch.runtime.claudeWindowLabel }
					: {}),
			},
		},
		startedAt: input.now,
		recovery: {
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		},
	});

	return {
		collabId,
		launchMode: launch.launchMode,
		launched: launch.launched,
		brokerPid,
		codexSessionId: codexSessionId as string,
		claudeSessionId: claudeSessionId as string,
	};
}
