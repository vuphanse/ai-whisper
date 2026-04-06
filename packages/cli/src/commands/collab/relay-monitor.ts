import { randomBytes } from "node:crypto";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { probeAndLatchBrokerState } from "../../runtime/recovery-guard.js";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { createRelayMonitorRuntime } from "../../runtime/relay-monitor.js";

export async function runCollabRelayMonitor(input: {
	workspaceRoot: string;
	assessBroker?: typeof assessBrokerDaemon;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	await probeAndLatchBrokerState(state, input.workspaceRoot, input.assessBroker);

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	const monitorId = `monitor_${randomBytes(9).toString("base64url")}`;
	const monitor = createRelayMonitorRuntime({
		broker,
		collabId: state.collabId,
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

	await monitor.start();
	await monitor.waitUntilStopped();
	if (!stoppedBySigint) {
		await broker.stop();
	}
}
