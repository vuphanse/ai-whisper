import { randomBytes } from "node:crypto";
import { createBrokerRuntime, openDatabase } from "@ai-whisper/broker";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { createRelayMonitorRuntime } from "../../runtime/relay-monitor.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

export interface RelayMonitorTargets {
	collabId: string;
	sqlitePath: string;
}

export function resolveRelayMonitorTargets(input: {
	cwd: string;
	collabIdOverride?: string;
}): RelayMonitorTargets {
	const sqlitePath = getSharedSqlitePath();
	const db = openDatabase(sqlitePath);
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		return { collabId: r.collabId, sqlitePath };
	} finally {
		db.close();
	}
}

export async function runCollabRelayMonitor(input: {
	cwd: string;
	collabIdOverride?: string;
	assessBroker?: typeof assessBrokerDaemon;
	brokerEnv?: { sqlitePath: string; host: string; port: number; collabId: string };
}) {
	let sqlitePath: string;
	let collabId: string;
	let host: string | undefined;
	let port: number | undefined;

	if (input.brokerEnv) {
		({ sqlitePath, host, port, collabId } = input.brokerEnv);
	} else {
		const targets = resolveRelayMonitorTargets({
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		sqlitePath = targets.sqlitePath;
		collabId = targets.collabId;
	}

	const broker = createBrokerRuntime({
		sqlitePath,
		...(host !== undefined ? { host } : {}),
		...(port !== undefined ? { port } : {}),
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});

	const monitorId = `monitor_${randomBytes(9).toString("base64url")}`;
	const monitor = createRelayMonitorRuntime({
		broker,
		collabId,
		monitorId,
		stdout: process.stdout,
	});

	let stoppedBySigint = false;
	process.on("SIGINT", () => {
		stoppedBySigint = true;
		monitor.stop()
			.then(() => broker.stop())
			.then(() => { process.exit(0); })
			.catch((err: unknown) => {
				console.error(err);
				process.exit(1);
			});
	});

	process.on("SIGTERM", () => {
		const hardExit = setTimeout(() => process.exit(1), 3000);
		hardExit.unref();
		monitor.stop()
			.then(() => broker.stop())
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
	process.on("uncaughtException", (err) => {
		const hardExit = setTimeout(() => process.exit(1), 3000);
		hardExit.unref();
		void monitor.stop().finally(() => {
			console.error(err);
			process.exit(1);
		});
	});

	monitor.start();
	await monitor.waitUntilStopped();
	if (!stoppedBySigint) {
		await broker.stop();
	}
}
