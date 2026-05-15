import { mkdirSync } from "node:fs";
import { dirname as pathDirname } from "node:path";
import { createBrokerRuntime } from "@ai-whisper/broker";
import {
	assessBrokerDaemon,
	spawnBrokerDaemon,
} from "../../runtime/broker-daemon.js";
import { createCliCollabId } from "../../runtime/id-factory.js";
import {
	launchSessions,
	type ExecFn,
	type LaunchMode,
	type SpawnFn,
} from "../../runtime/launcher.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import {
	findPortOwnerPid as defaultFindPortOwnerPid,
	isPortFree as defaultIsPortFree,
} from "../../runtime/port-utils.js";
import {
	readCliCollabState,
	writeCliCollabState,
} from "../../runtime/state-file.js";

async function waitForBrokerReady(input: {
	host: string;
	port: number;
	pid: number;
	assessBroker?: typeof assessBrokerDaemon;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
	delayMs?: number;
}) {
	const assess = input.assessBroker ?? assessBrokerDaemon;
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = input.attempts ?? 20;
	const delayMs = input.delayMs ?? 100;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const health = await assess({
			host: input.host,
			port: input.port,
			pid: input.pid,
		});
		if (health.ok) {
			return;
		}
		await sleep(delayMs);
	}

	throw new Error("Broker daemon failed to become ready.");
}

export async function runCollabStart(input: {
	workspaceRoot: string;
	now: string;
	launchMode: LaunchMode;
	attachTmux?: boolean;
	spawn?: SpawnFn;
	exec?: ExecFn;
	spawnBroker?: (sqlitePath: string, host: string, port: number, collabId: string) => number;
	assessBroker?: typeof assessBrokerDaemon;
	sleep?: (ms: number) => Promise<void>;
	isPortFree?: (port: number) => Promise<boolean>;
	findPortOwnerPid?: (port: number) => number | null;
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

	const isPortFree = input.isPortFree ?? defaultIsPortFree;
	const findPortOwnerPid =
		input.findPortOwnerPid ?? defaultFindPortOwnerPid;
	if (!(await isPortFree(brokerPort))) {
		const ownerPid = findPortOwnerPid(brokerPort);
		const ownerHint = ownerPid !== null ? ` (pid ${ownerPid})` : "";
		throw new Error(
			`Port ${brokerPort} is already in use${ownerHint}. A stale broker daemon may be running. Run \`whisper collab stop\` first, or kill the process manually.`,
		);
	}
	const sqliteDir = pathDirname(sqlitePath);
	mkdirSync(sqliteDir, { recursive: true });

	// Use in-process broker for initial setup (create collab, register sessions).
	// This broker is torn down once the daemon takes over the SQLite + port, so
	// it must not run any background drivers — the daemon owns those.
	const broker = createBrokerRuntime({
		sqlitePath,
		host: brokerHost,
		port: brokerPort,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
	});

	const collabId = createCliCollabId(input.now);

	const orchestratorEnabled = process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED !== "0";
	const orchestratorMaxRounds = Math.max(
		1,
		Number(process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS ?? "3") || 3,
	);

	broker.control.startCollab({
		collabId,
		workspaceRoot: input.workspaceRoot,
		displayName: "phase5",
		orchestratorEnabled,
		orchestratorMaxRounds,
		now: input.now,
	});

	// Close in-process broker so the daemon can claim the SQLite file and port
	await broker.stop();

	const startBroker = input.spawnBroker ?? spawnBrokerDaemon;
	const brokerPid = startBroker(sqlitePath, brokerHost, brokerPort, collabId);
	await waitForBrokerReady({
		host: brokerHost,
		port: brokerPort,
		pid: brokerPid,
		...(input.assessBroker ? { assessBroker: input.assessBroker } : {}),
		...(input.sleep ? { sleep: input.sleep } : {}),
	});

	const tmuxSession =
		input.launchMode === "tmux" ? `whisper-${collabId}` : undefined;

	// Write state file BEFORE launching panes so mount/relay-monitor panes can read it.
	writeCliCollabState(getStateFilePath(input.workspaceRoot), {
		version: 5,
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
			...(tmuxSession ? { tmuxSession } : {}),
		},
		ownedSessions: {},
		startedAt: input.now,
		recovery: {
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		},
		adoptedSessions: {},
		mountedSessions: {},
	});

	if (input.launchMode === "none") {
		console.log(
			"Collab started (no-launch mode).\nNext: run \"whisper collab relay-monitor\" in a separate terminal before mounting providers.",
		);
		return {
			collabId,
			launchMode: "none" as const,
			launched: false as const,
			brokerPid,
		};
	}

	const launch = launchSessions({
		launchMode: input.launchMode,
		...(input.attachTmux !== undefined ? { attachTmux: input.attachTmux } : {}),
		collabId,
		workspaceRoot: input.workspaceRoot,
		brokerSqlitePath: sqlitePath,
		brokerHost,
		brokerPort,
		...(input.spawn ? { spawn: input.spawn } : {}),
		...(input.exec ? { exec: input.exec } : {}),
	});

	return {
		collabId,
		launchMode: launch.launchMode,
		launched: launch.launched,
		brokerPid,
	};
}
