import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

describe("mounted turn-owned relay", () => {
	it("renders a pending handoff card for the owner and injects the accepted request", async () => {
		const writes: string[] = [];
		const injected: string[] = [];
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
			openComposer: () => Promise.resolve("Implement the approved plan\nKeep commits small.\n"),
		});

		relay.refreshOwnerView();
		await relay.acceptPendingHandoff();

		expect(writes.join("")).toContain("Pending handoff from codex");
		expect(injected.join("")).toContain("Implement the approved plan");
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
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "done" }),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).toHaveBeenCalled();
	});

	it("resets turn capture when handBackTo composer is cancelled", async () => {
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
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "some text" }),
			},
		});

		await relay.handBackTo("codex");
		expect(reset).toHaveBeenCalled();
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
});
