import type { BrokerRuntime } from "@ai-whisper/broker";

export function createMountedTurnOwnedRelay(input: {
	broker: BrokerRuntime;
	collabId: string;
	currentAgent: "codex" | "claude";
}) {
	const STALE_HANDOFF_AFTER_MS = 5 * 60_000;

	function refreshTurnState(now = new Date().toISOString()) {
		let state = input.broker.control.getRelayTurnState(input.collabId, now);
		if (
			state.unresolvedHandoffId &&
			(state.handoffState === "pending" ||
				state.handoffState === "deferred" ||
				state.handoffState === "accepted") &&
			state.handoffAgeMs !== null &&
			state.handoffAgeMs >= STALE_HANDOFF_AFTER_MS
		) {
			input.broker.control.markRelayHandoffStale({
				handoffId: state.unresolvedHandoffId,
				now,
			});
			state = input.broker.control.getRelayTurnState(input.collabId, now);
		}
		return state;
	}

	return {
		getWaitingGate() {
			return {
				isBlocked: () => refreshTurnState().waitingAgent === input.currentAgent,
				renderBlockedMessage: () => {
					const state = refreshTurnState();
					const elapsed =
						state.handoffAgeMs === null
							? "0s"
							: `${Math.floor(state.handoffAgeMs / 1000)}s`;
					return `waiting for reply from ${state.turnOwner} (${elapsed})`;
				},
				onCancel: () => {
					const state = refreshTurnState();
					if (state.unresolvedHandoffId) {
						input.broker.control.declineRelayHandoff({
							handoffId: state.unresolvedHandoffId,
							now: new Date().toISOString(),
						});
					}
				},
			};
		},
		async refreshOwnerView() {
			// No-op stub — will be implemented in Task 3.
		},
	};
}
