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
