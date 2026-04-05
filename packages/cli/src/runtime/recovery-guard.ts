import { assessBrokerDaemon } from "./broker-daemon.js";
import { writeCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";
import type { CliCollabState } from "./state-file.js";

export function assertNormalBrokerState(state: CliCollabState): void {
	if (state.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (state.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude>`.",
		);
	}
}

export async function probeAndLatchBrokerState(
	state: CliCollabState,
	workspaceRoot: string,
	assessBroker?: typeof assessBrokerDaemon,
): Promise<void> {
	if (state.recovery.state !== "normal") {
		assertNormalBrokerState(state);
		return;
	}

	const health = await (assessBroker ?? assessBrokerDaemon)({
		host: state.broker.host,
		port: state.broker.port,
		pid: state.broker.pid,
	});

	if (!health.ok) {
		writeCliCollabState(getStateFilePath(workspaceRoot), {
			...state,
			recovery: {
				state: "recovery_required",
				idleAfterRecovery: state.recovery.idleAfterRecovery,
				recoveredAt: state.recovery.recoveredAt,
			},
		});
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
}
