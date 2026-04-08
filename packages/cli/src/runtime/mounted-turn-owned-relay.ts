type RelayTurnState = {
	collabId: string;
	turnOwner: "codex" | "claude" | "none";
	waitingAgent: "codex" | "claude" | null;
	unresolvedHandoffId: string | null;
	handoffState: "idle" | "pending" | "deferred" | "accepted" | "stale_handoff" | "failed";
	handoffAgeMs: number | null;
};

type RelayHandoff = {
	handoffId: string;
	collabId: string;
	senderAgent: "codex" | "claude";
	targetAgent: "codex" | "claude";
	requestText: string;
	status: "pending" | "deferred" | "accepted" | "declined" | "handed_back" | "failed";
};

type BrokerLike = {
	control: {
		getRelayTurnState(collabId: string, now?: string): RelayTurnState;
		getRelayHandoff(handoffId: string): RelayHandoff | null;
		markRelayHandoffStale?(input: { handoffId: string; now: string }): void;
		acceptRelayHandoff(input: { handoffId: string; acceptedAt: string }): void;
		declineRelayHandoff(input: { handoffId: string; now: string }): void;
		deferRelayHandoff(input: { handoffId: string; deferredAt: string }): void;
		handoffBackRelay?(input: {
			handoffId: string;
			nextHandoffId: string;
			senderAgent: "codex" | "claude";
			targetAgent: "codex" | "claude";
			requestText: string;
			now: string;
		}): void;
	};
};

export function createMountedTurnOwnedRelay(input: {
	broker: BrokerLike;
	collabId: string;
	currentAgent: "codex" | "claude";
	writeLocalMessage: (text: string) => void;
	writeUserInput: (text: string) => void;
	openComposer: (args: { prompt: string; initialValue: string }) => Promise<string | null>;
	turnCapture?: {
		reset(): void;
		finishAssistantTurn(): void;
		extractLatestAssistantTurn(): { confidence: "high" | "low"; text: string | null };
	};
}) {
	const STALE_HANDOFF_AFTER_MS = 5 * 60_000;

	function refreshTurnState(now = new Date().toISOString()): RelayTurnState {
		let state = input.broker.control.getRelayTurnState(input.collabId, now);
		if (
			state.unresolvedHandoffId &&
			(state.handoffState === "pending" ||
				state.handoffState === "deferred" ||
				state.handoffState === "accepted") &&
			state.handoffAgeMs !== null &&
			state.handoffAgeMs >= STALE_HANDOFF_AFTER_MS
		) {
			input.broker.control.markRelayHandoffStale?.({
				handoffId: state.unresolvedHandoffId,
				now,
			});
			state = input.broker.control.getRelayTurnState(input.collabId, now);
		}
		return state;
	}

	function getPendingHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.turnOwner !== input.currentAgent) return null;
		if (!state.unresolvedHandoffId) return null;
		const handoff = input.broker.control.getRelayHandoff(state.unresolvedHandoffId);
		if (!handoff) return null;
		if (handoff.status !== "pending" && handoff.status !== "deferred") return null;
		if (handoff.targetAgent !== input.currentAgent) return null;
		return handoff;
	}

	function getAcceptedHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.turnOwner !== input.currentAgent) return null;
		if (!state.unresolvedHandoffId) return null;
		const handoff = input.broker.control.getRelayHandoff(state.unresolvedHandoffId);
		if (!handoff) return null;
		if (handoff.status !== "accepted") return null;
		if (handoff.targetAgent !== input.currentAgent) return null;
		return handoff;
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
			const handoff = getPendingHandoff();
			if (!handoff) return;
			const label = handoff.status === "deferred" ? "Deferred handoff" : "Pending handoff";
			input.writeLocalMessage(
				`[ai-whisper] ${label} from ${handoff.senderAgent}\n${handoff.requestText}\n[a] accept  [d] decline  [space] defer`,
			);
		},

		async acceptPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			const composed = await input.openComposer({
				prompt: "[ai-whisper] Edit the request text before accepting:",
				initialValue: handoff.requestText,
			});
			if (composed === null) return;
			input.turnCapture?.reset();
			const text = composed.endsWith("\n") ? composed : `${composed}\n`;
			input.writeUserInput(text);
			input.broker.control.acceptRelayHandoff({
				handoffId: handoff.handoffId,
				acceptedAt: new Date().toISOString(),
			});
		},

		async declinePendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			input.broker.control.declineRelayHandoff({
				handoffId: handoff.handoffId,
				now: new Date().toISOString(),
			});
		},

		async deferPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			input.broker.control.deferRelayHandoff({
				handoffId: handoff.handoffId,
				deferredAt: new Date().toISOString(),
			});
		},

		async handBackTo(target: "codex" | "claude") {
			const handoff = getAcceptedHandoff();
			if (!handoff) return;
			input.turnCapture?.finishAssistantTurn();
			const captured = input.turnCapture?.extractLatestAssistantTurn() ?? { confidence: "low" as const, text: null };
			const initialValue = captured.confidence === "high" && captured.text !== null ? captured.text : "";
			const composed = await input.openComposer({
				prompt: `[ai-whisper] Hand back to ${target}`,
				initialValue,
			});
			if (composed === null) return;
			const now = new Date().toISOString();
			input.broker.control.handoffBackRelay?.({
				handoffId: handoff.handoffId,
				nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
				senderAgent: input.currentAgent,
				targetAgent: target,
				requestText: composed,
				now,
			});
			input.turnCapture?.reset();
		},
	};
}
