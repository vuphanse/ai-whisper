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
		failRelayHandoffOnDisconnect?(input: { handoffId: string; now: string }): void;
		handoffBackRelay?(input: {
			handoffId: string;
			nextHandoffId: string;
			senderAgent: "codex" | "claude";
			targetAgent: "codex" | "claude";
			requestText: string;
			captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
			now: string;
		}): void;
	};
};

const CLEAR_LINE = "\r\u001b[2K";
const CURSOR_UP = "\u001b[1A";
const OWNER_CARD_BG = "\u001b[48;5;29m";
const OWNER_CARD_FG = "\u001b[38;5;250m";
const ANSI_RESET = "\u001b[0m";

function submitInjectedInput(writeUserInput: (text: string) => void, text: string) {
	writeUserInput(text);
	writeUserInput("\r");
}

function styleOwnerCard(message: string) {
	const lines = message.split("\n");
	const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
	return lines
		.map((line) => `${OWNER_CARD_BG}${OWNER_CARD_FG} ${line.padEnd(width, " ")} ${ANSI_RESET}`)
		.join("\n");
}

function computeLcs(a: string[], b: string[]): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		const row = dp[i]!;
		const prevRow = dp[i - 1]!;
		for (let j = 1; j <= n; j++) {
			row[j] =
				a[i - 1] === b[j - 1]
					? prevRow[j - 1]! + 1
					: Math.max(prevRow[j]!, row[j - 1]!);
		}
	}
	return dp[m]![n]!;
}

export function computeOrderedJaccard(a: string, b: string): number {
	const normalize = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
	const extractWords = (t: string) =>
		normalize(t)
			.split(" ")
			.filter((w) => w.length >= 4);

	const wa = extractWords(a);
	const wb = extractWords(b);
	const setA = new Set(wa);
	const setB = new Set(wb);
	const intersectionSize = [...setA].filter((w) => setB.has(w)).length;
	const unionSize = new Set([...setA, ...setB]).size;
	if (unionSize === 0) return 0;

	const jaccard = intersectionSize / unionSize;
	const lcs = computeLcs(wa, wb);
	const shorter = Math.min(wa.length, wb.length);
	if (shorter === 0) return 0;

	return jaccard * (lcs / shorter);
}

export function computeContainment(clip: string, turn: string): number {
	const normalize = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
	const extractWords = (t: string) =>
		normalize(t)
			.split(" ")
			.filter((w) => w.length >= 4);

	const clipWords = extractWords(clip);
	if (clipWords.length === 0) return 0;
	const turnSet = new Set(extractWords(turn));
	const matched = clipWords.filter((w) => turnSet.has(w)).length;
	return matched / clipWords.length;
}

export function classifyCapture(
	turnResult: { confidence: "high" | "low"; text: string | null },
	clipboardText: string | null,
): "ok" | "no_response_captured_confidently" | "no_response_captured" {
	const turnText = turnResult.text ?? "";
	const clipText = clipboardText ?? "";

	if (turnText.trim().length === 0 && clipText.trim().length === 0) {
		return "no_response_captured";
	}

	if (clipText.trim().length > 0) {
		// Substantial clipboard (>= 100 chars): trust it as a fresh /copy capture.
		// Full-screen TUI providers (e.g. Claude Code) produce cursor-positioned PTY
		// output that normalizeCapturedOutput cannot reconstruct, so PTY similarity
		// checks always fail even when the response is valid. The clipboard change
		// detection in captureClipboardHandback already guarantees freshness.
		if (clipText.trim().length >= 100) {
			return "ok";
		}

		// Short clipboard: require PTY similarity to rule out stale or unrelated content.
		if (
			turnResult.confidence === "high" &&
			(computeOrderedJaccard(turnText, clipText) >= 0.6 ||
				computeContainment(clipText, turnText) >= 0.8)
		) {
			return "ok";
		}
	}

	return "no_response_captured_confidently";
}

export function createMountedTurnOwnedRelay(input: {
	broker: BrokerLike;
	collabId: string;
	currentAgent: "codex" | "claude";
	writeLocalMessage: (text: string) => void;
	writeUserInput: (text: string) => void;
	submitUserInput?: (text: string) => Promise<void>;
	openComposer: (args: { prompt: string; initialValue: string }) => Promise<string | null>;
	captureHandbackText?: () => Promise<string | null>;
	confirmHandbackCapture?: (args: { target: "codex" | "claude"; text: string }) => Promise<boolean>;
	prefillHandbackFromCapture?: boolean;
	turnCapture?: {
		reset(): void;
		finishAssistantTurn(): void;
		hasVisibleAssistantTurn(): boolean;
		extractLatestAssistantTurn(): { confidence: "high" | "low"; text: string | null };
	};
	isPausedInput?: () => boolean;
	onHandoffAccepted?: () => void;
}) {
	const STALE_HANDOFF_AFTER_MS = 5 * 60_000;
	const HAND_BACK_READY_AFTER_MS = 30_000;
	let disconnectHandled = false;
	let lastOwnerCardKey: string | null = null;
	let renderedOwnerCardLines = 0;
	let autoAcceptFiredFor: string | null = null;
	let autoHandbackFiredFor: string | null = null;

	function clearOwnerCard() {
		if (renderedOwnerCardLines === 0) {
			return;
		}

		let control = "";
		for (let index = 0; index < renderedOwnerCardLines; index += 1) {
			control += CLEAR_LINE;
			if (index < renderedOwnerCardLines - 1) {
				control += CURSOR_UP;
			}
		}
		input.writeLocalMessage(control);
		renderedOwnerCardLines = 0;
	}

	function renderOwnerCard(message: string, cardKey: string) {
		if (cardKey === lastOwnerCardKey) {
			return;
		}
		clearOwnerCard();
		lastOwnerCardKey = cardKey;
		renderedOwnerCardLines = message.split("\n").length;
		input.writeLocalMessage(styleOwnerCard(message));
	}

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

	function getAcceptedReadyHandoff(): RelayHandoff | null {
		const state = refreshTurnState();
		if (state.handoffAgeMs === null || state.handoffAgeMs < HAND_BACK_READY_AFTER_MS) {
			return null;
		}
		const handoff = getAcceptedHandoff();
		if (!handoff) return null;
		if (!input.turnCapture?.hasVisibleAssistantTurn()) return null;
		return handoff;
	}

	function getAcceptedForceableHandoff(): RelayHandoff | null {
		return getAcceptedHandoff();
	}

	async function handleOwnerInput(text: string): Promise<boolean> {
		const handoff = getPendingHandoff();
		if (handoff) {
			if (text === "a" || text === "A") {
				await api.acceptPendingHandoff();
				return true;
			}
			if (text === "e" || text === "E") {
				await api.amendPendingHandoff();
				return true;
			}
			if (text === "d" || text === "D") {
				api.declinePendingHandoff();
				return true;
			}
			if (text === " ") {
				api.deferPendingHandoff();
				return true;
			}
		}

		const forceable = getAcceptedForceableHandoff();
		if (forceable && text === "\u0008") {
			await api.handBackTo(forceable.senderAgent, { force: true });
			return true;
		}

		const accepted = getAcceptedReadyHandoff();
		if (accepted && (text === "h" || text === "H")) {
			await api.handBackTo(accepted.senderAgent);
			return true;
		}
		return false;
	}

	const api = {
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

		refreshOwnerView() {
			const handoff = getPendingHandoff();
			if (handoff) {
				const label = handoff.status === "deferred" ? "Deferred handoff" : "Pending handoff";
				const cardKey = `${handoff.handoffId}|${handoff.status}|${handoff.requestText}`;
				renderOwnerCard(
					`[ai-whisper] ${label} from ${handoff.senderAgent}\n${handoff.requestText}\n[a] accept  [e] amend  [d] decline  [space] defer`,
					cardKey,
				);
				return;
			}

			const accepted = getAcceptedReadyHandoff();
			if (accepted) {
				const cardKey = `${accepted.handoffId}|accepted-ready|${accepted.senderAgent}`;
				renderOwnerCard(
					`[ai-whisper] Ready to hand back to ${accepted.senderAgent}  [h] hand back`,
					cardKey,
				);
				return;
			}

			clearOwnerCard();
			lastOwnerCardKey = null;
		},

		async acceptPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			input.turnCapture?.reset();
			autoHandbackFiredFor = null;
			if (input.submitUserInput) {
				await input.submitUserInput(handoff.requestText);
			} else {
				submitInjectedInput(input.writeUserInput, handoff.requestText);
			}
			input.broker.control.acceptRelayHandoff({
				handoffId: handoff.handoffId,
				acceptedAt: new Date().toISOString(),
			});
			input.onHandoffAccepted?.();
		},

		async amendPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			const composed = await input.openComposer({
				prompt: "[ai-whisper] Edit the request text before accepting:",
				initialValue: handoff.requestText,
			});
			if (composed === null) return;
			input.turnCapture?.reset();
			input.writeUserInput(composed);
			input.broker.control.acceptRelayHandoff({
				handoffId: handoff.handoffId,
				acceptedAt: new Date().toISOString(),
			});
		},

		declinePendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			autoAcceptFiredFor = null;
			input.broker.control.declineRelayHandoff({
				handoffId: handoff.handoffId,
				now: new Date().toISOString(),
			});
		},

		deferPendingHandoff() {
			const handoff = getPendingHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			input.broker.control.deferRelayHandoff({
				handoffId: handoff.handoffId,
				deferredAt: new Date().toISOString(),
			});
		},

		async handBackTo(
			target: "codex" | "claude",
			options?: { force?: boolean },
		) {
			const handoff = getAcceptedHandoff();
			if (!handoff) return;
			clearOwnerCard();
			lastOwnerCardKey = null;
			if (options?.force) {
				input.writeLocalMessage(
					`[ai-whisper] Force handback to ${target}: attempting /copy first`,
				);
			}
			let composed: string | null = null;
			let initialValue = "";
			if (input.captureHandbackText) {
				const captured = (await input.captureHandbackText()) ?? "";
				if (captured.trim().length > 0 && input.confirmHandbackCapture) {
					const accepted = await input.confirmHandbackCapture({
						target,
						text: captured,
					});
					if (!accepted) {
						return;
					}
					composed = captured;
				} else {
					initialValue = captured;
				}
			} else if (input.prefillHandbackFromCapture !== false) {
				input.turnCapture?.finishAssistantTurn();
				const captured = input.turnCapture?.extractLatestAssistantTurn() ?? { confidence: "low" as const, text: null };
				initialValue = captured.confidence === "high" && captured.text !== null ? captured.text : "";
			}
			if (composed === null) {
				composed = await input.openComposer({
					prompt: `[ai-whisper] Hand back to ${target}`,
					initialValue,
				});
			}
			if (composed === null) {
				return;
			}
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

		async checkIdleActions() {
			// Auto-accept: pending (not deferred) handoff, guard not set, not paused
			const pending = getPendingHandoff();
			if (
				pending !== null &&
				pending.status === "pending" &&
				autoAcceptFiredFor !== pending.handoffId &&
				!(input.isPausedInput?.() ?? false)
			) {
				autoAcceptFiredFor = pending.handoffId;
				await api.acceptPendingHandoff();
				return;
			}

			// Auto-handback: accepted handoff, guard not set, not paused
			const accepted = getAcceptedHandoff();
			if (
				accepted === null ||
				autoHandbackFiredFor === accepted.handoffId ||
				(input.isPausedInput?.() ?? false)
			) {
				return;
			}

			autoHandbackFiredFor = accepted.handoffId;

			// Always extract turn text before attempting clipboard capture — must run even if clipboard throws.
			// finishAssistantTurn clears the streaming flag so extractLatestAssistantTurn
			// can return high-confidence text; without this call it always returns low/null.
			input.turnCapture?.finishAssistantTurn();
			const turnResult: { confidence: "high" | "low"; text: string | null } =
				input.turnCapture?.extractLatestAssistantTurn() ?? { confidence: "low", text: null };

			let clipboardText: string | null = null;
			try {
				clipboardText = (await input.captureHandbackText?.()) ?? null;
			} catch {
				clipboardText = null;
			}

			const captureStatus = classifyCapture(turnResult, clipboardText);
			const requestText = captureStatus === "ok" ? (clipboardText ?? "") : "";

			if (process.env["AI_WHISPER_DEBUG_CAPTURE"]) {
				const { writeFileSync } = await import("node:fs");
				writeFileSync(
					process.env["AI_WHISPER_DEBUG_CAPTURE"],
					JSON.stringify({
						captureStatus,
						turnTextLen: (turnResult.text ?? "").length,
						clipLen: (clipboardText ?? "").length,
						turnText: turnResult.text,
						clipText: clipboardText,
					}, null, 2),
					"utf8",
				);
			}

			// Race guard: original handoff must still be the accepted one after async capture.
			// A different handoffId means the original was resolved mid-capture; abort silently.
			if (getAcceptedHandoff()?.handoffId !== accepted.handoffId) return;

			const now = new Date().toISOString();
			input.broker.control.handoffBackRelay?.({
				handoffId: accepted.handoffId,
				nextHandoffId: `handoff_${now.replace(/[^0-9]/g, "")}`,
				senderAgent: input.currentAgent,
				targetAgent: accepted.senderAgent,
				requestText,
				captureStatus,
				now,
			});
			input.turnCapture?.reset();
		},

		handleOwnerDisconnect() {
			if (disconnectHandled) return;
			disconnectHandled = true;
			const state = input.broker.control.getRelayTurnState(input.collabId);
			if (state.turnOwner !== input.currentAgent) {
				return;
			}
			if (!state.unresolvedHandoffId) {
				return;
			}
			input.broker.control.failRelayHandoffOnDisconnect?.({
				handoffId: state.unresolvedHandoffId,
				now: new Date().toISOString(),
			});
			input.writeLocalMessage(
				`[ai-whisper] Mounted ${input.currentAgent} session disconnected during unresolved handoff.`,
			);
		},
		handleOwnerInput,
	};

	return api;
}
