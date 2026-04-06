import { createBrokerRuntime } from "@ai-whisper/broker";
import { assessBrokerDaemon, spawnBrokerDaemon } from "../../runtime/broker-daemon.js";
import { readCliCollabState, writeCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";

export async function runCollabRecover(input: {
	workspaceRoot: string;
	now: string;
	assessBroker?: typeof assessBrokerDaemon;
	spawnBroker?: typeof spawnBrokerDaemon;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab to recover.");
	}

	const health = await (input.assessBroker ?? assessBrokerDaemon)({
		host: state.broker.host,
		port: state.broker.port,
		pid: state.broker.pid,
	});

	if (health.ok) {
		throw new Error("Broker is already healthy. Recovery is not needed.");
	}

	const brokerPid = (input.spawnBroker ?? spawnBrokerDaemon)(
		state.broker.sqlitePath,
		state.broker.host,
		state.broker.port,
	);

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	const prepared = broker.control.prepareCollabRecovery({
		collabId: state.collabId,
		now: input.now,
	});
	await broker.stop();

	const hasRememberedBindings = prepared.bindings.some((b) => b.activeSessionId !== null);

	writeCliCollabState(getStateFilePath(input.workspaceRoot), {
		...state,
		version: 5,
		broker: { ...state.broker, pid: brokerPid },
		recovery: hasRememberedBindings
			? {
					state: "recovered",
					idleAfterRecovery: true,
					recoveredAt: input.now,
			  }
			: {
					state: "normal",
					idleAfterRecovery: false,
					recoveredAt: null,
			  },
		mountedSessions: state.mountedSessions ?? {},
	});

	return {
		recovered: true as const,
		idleAfterRecovery: hasRememberedBindings,
		roles: {
			codex: { health: "degraded" as const },
			claude: { health: "degraded" as const },
		},
		bindings: prepared.bindings,
	};
}
