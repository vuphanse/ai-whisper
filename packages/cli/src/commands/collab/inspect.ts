import { createBrokerRuntime } from "@ai-whisper/broker";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { buildInspectSnapshot, formatInspectSnapshot } from "../../runtime/operator-inspect.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";

export async function runCollabInspect(input: {
	workspaceRoot: string;
	now: string;
	watch: boolean;
	assessBroker?: typeof assessBrokerDaemon;
	write?: (chunk: string) => void;
	sleep?: (ms: number) => Promise<void>;
	watchIntervalMs?: number;
}) {
	const renderOnce = async (timestamp: string) => {
		const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
		if (!state) {
			throw new Error("No active collab. Run `whisper collab start` first.");
		}

		const health = await (input.assessBroker ?? assessBrokerDaemon)({
			host: state.broker.host,
			port: state.broker.port,
			pid: state.broker.pid,
		});

		if (!health.ok && state.recovery.state === "recovery_required") {
			throw new Error("Broker is unavailable for the current collab. Run `whisper collab recover`.");
		}

		const broker = createBrokerRuntime({
			sqlitePath: state.broker.sqlitePath,
			host: state.broker.host,
			port: state.broker.port,
		});

		try {
			const snapshot = buildInspectSnapshot({ broker, state, now: timestamp });
			return formatInspectSnapshot({
				...snapshot,
				watch: input.watch,
				brokerHealth: health.ok ? "ok" : "degraded",
			});
		} finally {
			await broker.stop();
		}
	};

	if (!input.watch) {
		return renderOnce(input.now);
	}

	// Watch mode placeholder — implemented in Task 4
	throw new Error("Watch mode not yet implemented.");
}
