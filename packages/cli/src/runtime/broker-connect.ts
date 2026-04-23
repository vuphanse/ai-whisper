import { createBrokerRuntime } from "@ai-whisper/broker";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { getBrokerSqlitePath, getStateFilePath } from "./paths.js";
import { readCliCollabState } from "./state-file.js";
import { probeAndLatchBrokerState } from "./recovery-guard.js";
import { assessBrokerDaemon } from "./broker-daemon.js";

export async function connectToWorkspaceBroker(
	workspaceRoot: string,
	assessBroker?: typeof assessBrokerDaemon,
): Promise<{ broker: BrokerRuntime; collabId: string }> {
	const state = readCliCollabState(getStateFilePath(workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	await probeAndLatchBrokerState(state, workspaceRoot, assessBroker);

	const broker = createBrokerRuntime({
		sqlitePath: getBrokerSqlitePath(workspaceRoot),
		host: state.broker.host,
		port: state.broker.port,
	});

	return { broker, collabId: state.collabId };
}
