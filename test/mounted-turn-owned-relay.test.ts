import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

describe("mounted turn-owned relay", () => {
	it("renders a pending handoff card for the owner and injects/submits the accepted request immediately", async () => {
		const writes: string[] = [];
		const injected: string[] = [];
		const openComposer = vi.fn();
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => { writes.push(text); },
			writeUserInput: (text: string) => { injected.push(text); },
			openComposer,
		});

		relay.refreshOwnerView();
		await relay.acceptPendingHandoff();

		expect(writes.join("")).toContain("Pending handoff from codex");
		expect(injected).toEqual([
			"Implement the approved plan\nKeep commits small.",
			"\r",
		]);
		expect(openComposer).not.toHaveBeenCalled();
	});

	it("renders pending handoff cards with distinct multiline local styling", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) { writes.push(text); },
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();

		const rendered = writes.join("");
		const ownerCardBackground = "\u001b[48;5;29m";
		const ownerCardForeground = "\u001b[38;5;250m";
		const ansiReset = "\u001b[0m";
		expect(rendered).toContain("\u001b[48;5;29m");
		expect(rendered).toContain("\u001b[38;5;250m");
		expect(rendered).toContain("[ai-whisper] Pending handoff from codex");
		expect(rendered).toContain("Implement the approved plan");
		expect(rendered).toContain("Keep commits small.");
		expect(rendered).toContain("[a] accept  [e] amend  [d] decline  [space] defer");

		const visibleLines = rendered
			.split("\n")
			.map((line) =>
				line
					.replaceAll(ownerCardBackground, "")
					.replaceAll(ownerCardForeground, "")
					.replaceAll(ansiReset, ""),
			);
		const widths = visibleLines.map((line) => line.length);
		expect(new Set(widths).size).toBe(1);
	});

	it("clears the rendered pending handoff card after accept", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi
					.fn()
					.mockReturnValueOnce({
						collabId: "collab_turn",
						turnOwner: "claude" as const,
						waitingAgent: "codex" as const,
						unresolvedHandoffId: "handoff_1",
						handoffState: "pending" as const,
						handoffAgeMs: 1_000,
					})
					.mockReturnValue({
						collabId: "collab_turn",
						turnOwner: "claude" as const,
						waitingAgent: "codex" as const,
						unresolvedHandoffId: "handoff_1",
						handoffState: "pending" as const,
						handoffAgeMs: 1_000,
					}),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) { writes.push(text); },
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		await relay.acceptPendingHandoff();

		expect(writes.join("")).toContain("Pending handoff from codex");
		expect(writes.join("")).toContain("\r\u001b[2K");
	});

	it("opens the editor when the owner chooses amend before accepting and injects without submitting", async () => {
		const injected: string[] = [];
		const openComposer = vi.fn(() =>
			Promise.resolve("Implement the approved plan\nKeep commits very small.\n"),
		);
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan\nKeep commits small.",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput: (text: string) => { injected.push(text); },
			openComposer,
		});

		await relay.handleOwnerInput("e");

		expect(openComposer).toHaveBeenCalledWith(
			expect.objectContaining({
				initialValue: "Implement the approved plan\nKeep commits small.",
			}),
		);
		expect(injected[0]).toBe("Implement the approved plan\nKeep commits very small.\n");
	});

	it("declines a pending handoff without requiring a reason", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(""),
		});

		relay.declinePendingHandoff();
		expect(broker.control.declineRelayHandoff).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("defers a pending handoff and keeps the sender waiting", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				deferRelayHandoff: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(""),
		});

		relay.deferPendingHandoff();
		expect(broker.control.deferRelayHandoff).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("renders 'Deferred' label when the pending handoff has been deferred", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "deferred" as const,
					handoffAgeMs: 60_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "deferred" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => { writes.push(text); },
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		expect(writes.join("")).toContain("Deferred");
		expect(writes.join("")).toContain("codex");
	});

	it("does not re-render the same owner card on repeated refreshes", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "pending" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "pending" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: (text: string) => { writes.push(text); },
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.refreshOwnerView();
		relay.refreshOwnerView();

		expect(writes).toHaveLength(1);
	});

	it("does not fail the handoff when the disconnect comes from the waiting side", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 10_000,
				})),
				failRelayHandoffOnDisconnect: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				getRelayHandoff: vi.fn(() => null),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "codex",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.handleOwnerDisconnect();

		expect(broker.control.failRelayHandoffOnDisconnect).not.toHaveBeenCalled();
	});

	it("prefills handback from the latest assistant turn and falls back to blank composer on low confidence", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) => Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "Implemented the plan." }),
			},
		});

		await relay.handBackTo("codex");
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				senderAgent: "claude",
				targetAgent: "codex",
				requestText: "Implemented the plan.",
			}),
		);
	});

	it("resets turn capture after successful handback to prevent stale text on retry", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const reset = vi.fn();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve("done"),
			turnCapture: {
				reset,
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "done" }),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).toHaveBeenCalled();
	});

	it("keeps turn capture intact when handBackTo composer is cancelled", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};
		const reset = vi.fn();
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null as string | null),
			turnCapture: {
				reset,
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "some text" }),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).not.toHaveBeenCalled();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("opens blank composer when turn capture confidence is low", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "low" as const, text: null }),
			},
		});

		await relay.handBackTo("codex");

		expect(composerArgs[0]?.initialValue).toBe("");
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "manual result",
			}),
		);
	});

	it("opens blank handback composer when mounted mode disables capture prefills", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "noisy terminal output" }),
			},
		});

		await relay.handBackTo("codex");

		expect(composerArgs[0]?.initialValue).toBe("");
	});

	it("uses explicit handback capture when available", async () => {
		const composerArgs: Array<{ prompt: string; initialValue: string }> = [];
		const confirmHandbackCapture = vi.fn(() => Promise.resolve(true));
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 20_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: (args: { prompt: string; initialValue: string }) => {
				composerArgs.push(args);
				return Promise.resolve("manual result");
			},
			confirmHandbackCapture,
			captureHandbackText: () => Promise.resolve("copied latest response"),
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "noisy terminal output" }),
			},
		});

		await relay.handBackTo("codex");

		expect(confirmHandbackCapture).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "codex",
				text: "copied latest response",
			}),
		);
		expect(composerArgs).toEqual([]);
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "copied latest response",
			}),
		);
	});

	it("does not hand back when copied response confirmation is cancelled", async () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 20_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve("manual result"),
			confirmHandbackCapture: () => Promise.resolve(false),
			captureHandbackText: () => Promise.resolve("copied latest response"),
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "noisy terminal output" }),
			},
		});

		await relay.handBackTo("codex");

		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("shows handback hint and routes h to the original sender after 30s and visible output", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 35_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) { writes.push(text); },
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) => Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "Implemented the plan." }),
			},
		});

		relay.refreshOwnerView();
		await relay.handleOwnerInput("h");

		expect(writes.join("")).toContain("Ready to hand back to codex");
		expect(writes.join("")).toContain("[h] hand back");
		expect(writes.join("")).not.toContain("Ready to hand back to codex\n[h] hand back");
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "Implemented the plan.",
			}),
		);
	});

	it("does not show the handback hint before the 30s accepted grace period elapses", () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) { writes.push(text); },
			writeUserInput() {},
			openComposer: ({ initialValue }: { initialValue: string }) => Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => true,
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "Implemented the plan." }),
			},
		});

		relay.refreshOwnerView();

		expect(writes.join("")).not.toContain("Ready to hand back");
	});

	it("forces handback with Ctrl+H before readiness gates and falls back to manual composer", async () => {
		const writes: string[] = [];
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 1_000,
				})),
				getRelayHandoff: vi.fn(() => ({
					handoffId: "handoff_1",
					collabId: "collab_turn",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Implement the approved plan",
					status: "accepted" as const,
				})),
				handoffBackRelay: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
			},
		};
		const openComposer = vi.fn(() => Promise.resolve("manual result"));
		const confirmHandbackCapture = vi.fn(() => Promise.resolve(true));

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage(text: string) { writes.push(text); },
			writeUserInput() {},
			openComposer,
			captureHandbackText: () => Promise.resolve(null),
			confirmHandbackCapture,
			prefillHandbackFromCapture: false,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: () => false,
				extractLatestAssistantTurn: () => ({ confidence: "low" as const, text: null }),
			},
		});

		await relay.handleOwnerInput("\u0008");

		expect(writes.join("")).toContain("Force handback");
		expect(openComposer).toHaveBeenCalled();
		expect(confirmHandbackCapture).not.toHaveBeenCalled();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: "codex",
				requestText: "manual result",
			}),
		);
	});

	it("releases the sender and marks the handoff degraded when the owner session exits", () => {
		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_turn",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 10_000,
				})),
				failRelayHandoffOnDisconnect: vi.fn(),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				getRelayHandoff: vi.fn(() => null),
			},
		};
		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage() {},
			writeUserInput() {},
			openComposer: () => Promise.resolve(null),
		});

		relay.handleOwnerDisconnect();

		expect(broker.control.failRelayHandoffOnDisconnect).toHaveBeenCalledWith(
			expect.objectContaining({ handoffId: "handoff_1" }),
		);
	});

	it("swallows ordinary waiting-side input but allows Ctrl+C", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];

		const onCancel = vi.fn();
		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) { userInputs.push(data); },
				sendLocalMessage(data: string) { localMessages.push(data); },
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputGate: {
				isBlocked: () => true,
				renderBlockedMessage: () => "waiting for reply from claude (12s)",
				onCancel,
			},
		});

		await runtime.start();
		stdin.write("hello");
		stdin.write("\u0003");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(userInputs).toEqual([]);
		expect(localMessages.join("")).toContain("waiting for reply from claude");
		expect(onCancel).toHaveBeenCalled();
		expect(runtime).toBeTruthy();
	});

	it("routes owner-side handoff hotkeys before provider passthrough", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];
			const handleOwnerInput = vi.fn((text: string) => Promise.resolve(text === "a"));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) { userInputs.push(data); },
				sendLocalMessage(data: string) { localMessages.push(data); },
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputRouter: {
				handleInput: handleOwnerInput,
			},
		});

		await runtime.start();
		stdin.write("a");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleOwnerInput).toHaveBeenCalledWith("a");
		expect(userInputs).toEqual([]);
		expect(localMessages).toEqual([]);
	});

	it("routes owner-side handoff hotkeys when the terminal reports printable keys as CSI-u only", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];
		const handleOwnerInput = vi.fn((text: string) => Promise.resolve(text === "a"));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) { userInputs.push(data); },
				sendLocalMessage(data: string) { localMessages.push(data); },
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: () => Promise.resolve(null),
			externalInputRouter: {
				handleInput: handleOwnerInput,
			},
		});

		await runtime.start();
		stdin.write("\u001b[97;1:3u");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleOwnerInput).toHaveBeenCalledWith("a");
		expect(userInputs).toEqual([]);
		expect(localMessages).toEqual([]);
	});
});
