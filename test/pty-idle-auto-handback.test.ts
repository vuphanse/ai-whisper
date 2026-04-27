import { describe, expect, it, vi } from "vitest";
import {
	createMountedTurnOwnedRelay,
	computeOrderedJaccard,
	computeContainment,
	classifyCapture,
} from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

// ---------------------------------------------------------------------------
// Ordered Jaccard + capture classification
// ---------------------------------------------------------------------------

describe("computeOrderedJaccard", () => {
	it("returns 1.0 for identical texts", () => {
		expect(computeOrderedJaccard("the quick brown fox", "the quick brown fox")).toBeCloseTo(1.0, 2);
	});

	it("returns 0 when both texts are empty", () => {
		expect(computeOrderedJaccard("", "")).toBe(0);
	});

	it("returns 0 when neither text has words of length >= 4", () => {
		expect(computeOrderedJaccard("hi ok no", "hi ok no")).toBe(0);
	});

	it("penalises reversed word order below 0.6", () => {
		const a = "alpha beta gamma delta epsilon";
		const b = "epsilon delta gamma beta alpha";
		expect(computeOrderedJaccard(a, b)).toBeLessThan(0.6);
	});

	it("scores same-order overlap at or above 0.6", () => {
		const a = "implement approved plan keep commits small verify tests pass";
		const b = "implement approved plan keep commits small verify tests pass done";
		expect(computeOrderedJaccard(a, b)).toBeGreaterThanOrEqual(0.6);
	});
});

describe("computeContainment", () => {
	it("returns 1.0 when all clipboard words appear in turn text", () => {
		expect(computeContainment("done", "done harmonizing clipboard update")).toBeCloseTo(1.0);
	});

	it("returns partial score when only some clipboard words appear in turn text", () => {
		// "review" and "roadmap" appear; "missing" does not
		const clip = "review roadmap missing";
		const turn = "review the roadmap carefully for updates";
		expect(computeContainment(clip, turn)).toBeCloseTo(2 / 3, 2);
	});

	it("returns 0 when no clipboard words appear in turn text", () => {
		expect(computeContainment("unrelated word here", "completely different output")).toBe(0);
	});

	it("returns 0 when clipboard has no words of length >= 4", () => {
		expect(computeContainment("hi ok", "some longer turn text here")).toBe(0);
	});

	it("returns 0 when clipboard is empty", () => {
		expect(computeContainment("", "some turn text here")).toBe(0);
	});

	it("is case-insensitive", () => {
		expect(computeContainment("DONE", "done harmonizing")).toBeCloseTo(1.0);
	});
});

describe("classifyCapture", () => {
	it("returns no_response_captured when both signals empty", () => {
		expect(classifyCapture({ confidence: "low", text: null }, null)).toBe(
			"no_response_captured",
		);
		expect(classifyCapture({ confidence: "high", text: "" }, "")).toBe(
			"no_response_captured",
		);
	});

	it("returns ok when high confidence + clipboard non-empty + jaccard >= 0.6", () => {
		const text = "implement approved plan keep commits small verify tests pass";
		expect(classifyCapture({ confidence: "high", text }, text)).toBe("ok");
	});

	it("returns ok when clipboard is substantial (>= 100 chars) regardless of PTY confidence", () => {
		// Simulates full-screen TUI providers (e.g. Claude Code) where PTY text
		// normalization produces nothing but clipboard holds the real response.
		const substantialResponse = "a".repeat(100);
		expect(classifyCapture({ confidence: "low", text: null }, substantialResponse)).toBe("ok");
	});

	it("returns no_response_captured_confidently when confidence is low and clipboard short", () => {
		expect(
			classifyCapture({ confidence: "low", text: "something here" }, "something here"),
		).toBe("no_response_captured_confidently");
	});

	it("returns no_response_captured_confidently when jaccard < 0.6 and containment < 0.8", () => {
		// Completely different vocabulary: no words overlap between clip and turn
		const turnText = "zebra monkey banana orange apple grape lemon melon";
		const clipText = "implement approve commit verify tests pass done";
		expect(classifyCapture({ confidence: "high", text: turnText }, clipText)).toBe(
			"no_response_captured_confidently",
		);
	});

	it("returns ok via containment when clipboard words are mostly present in verbose PTY output", () => {
		// Simulates real provider terminal: short response + chrome tokens
		const turnText =
			"done harmonizing clipboard copied characters lines written update available upgrade";
		const clipText = "done";
		// jaccard = 1/10 = 0.1 < 0.6, but containment = 1/1 = 1.0 >= 0.8 → ok
		expect(classifyCapture({ confidence: "high", text: turnText }, clipText)).toBe("ok");
	});

	it("returns no_response_captured_confidently when clipboard is empty but turn text exists", () => {
		expect(classifyCapture({ confidence: "high", text: "some output here" }, null)).toBe(
			"no_response_captured_confidently",
		);
	});
});

// ---------------------------------------------------------------------------
// checkIdleActions
// ---------------------------------------------------------------------------

function makeRelayForIdle(opts: {
	handoffStatus: "none" | "pending" | "deferred" | "accepted";
	isPausedInput?: () => boolean;
	captureHandbackText?: () => Promise<string | null>;
	turnCapture?: {
		reset: () => void;
		finishAssistantTurn: () => void;
		hasVisibleAssistantTurn: () => boolean;
		extractLatestAssistantTurn: () => { confidence: "high" | "low"; text: string | null };
	};
	autonomous?: boolean;
	handoffAgeMs?: number;
}) {
	const { handoffStatus } = opts;
	const handoffId = "handoff_idle_1";
	const handoff =
		handoffStatus === "none"
			? null
			: {
					handoffId,
					collabId: "collab_idle",
					senderAgent: "codex" as const,
					targetAgent: "claude" as const,
					requestText: "Do the work",
					status: handoffStatus as "pending" | "deferred" | "accepted",
				};

	const broker = {
		control: {
			getRelayTurnState: vi.fn(() => ({
				collabId: "collab_idle",
				turnOwner: "claude" as const,
				waitingAgent: "codex" as const,
				unresolvedHandoffId: handoff ? handoffId : null,
				handoffState: (handoffStatus === "none" ? "idle" : handoffStatus) as
					| "idle"
					| "pending"
					| "deferred"
					| "accepted",
				handoffAgeMs: opts.handoffAgeMs ?? 5_000,
			})),
			getRelayHandoff: vi.fn(() => handoff),
			acceptRelayHandoff: vi.fn(),
			declineRelayHandoff: vi.fn(),
			deferRelayHandoff: vi.fn(),
			markRelayHandoffStale: vi.fn(),
			handoffBackRelay: vi.fn(),
			...(opts.autonomous
				? {
						getHandoffWithWorkflowMeta: vi.fn(() => ({
							workflowId: "wf_test",
							chainId: "ch_test",
						})),
						getWorkflow: vi.fn(() => ({ status: "running" })),
						getRelayChain: vi.fn(() => ({ status: "active" })),
					}
				: {}),
		},
	};

	const relay = createMountedTurnOwnedRelay({
		broker,
		collabId: "collab_idle",
		currentAgent: "claude",
		writeLocalMessage: vi.fn(),
		writeUserInput: vi.fn(),
		openComposer: vi.fn(),
		...(opts.isPausedInput !== undefined ? { isPausedInput: opts.isPausedInput } : {}),
		...(opts.captureHandbackText !== undefined ? { captureHandbackText: opts.captureHandbackText } : {}),
		...(opts.turnCapture !== undefined ? { turnCapture: opts.turnCapture } : {}),
	});

	return { relay, broker };
}

describe("checkIdleActions: auto-accept", () => {
	it("auto-accepts a pending handoff and returns without firing auto-handback on same tick", async () => {
		const { relay, broker } = makeRelayForIdle({ handoffStatus: "pending" });
		await relay.checkIdleActions();
		expect(broker.control.acceptRelayHandoff).toHaveBeenCalledWith({
			handoffId: "handoff_idle_1",
			acceptedAt: expect.any(String),
		});
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("does not auto-accept a deferred handoff", async () => {
		const { relay, broker } = makeRelayForIdle({ handoffStatus: "deferred" });
		await relay.checkIdleActions();
		expect(broker.control.acceptRelayHandoff).not.toHaveBeenCalled();
	});

	it("does not auto-accept when isPausedInput returns true", async () => {
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "pending",
			isPausedInput: () => true,
		});
		await relay.checkIdleActions();
		expect(broker.control.acceptRelayHandoff).not.toHaveBeenCalled();
	});

	it("does not fire auto-accept twice for same handoffId", async () => {
		const { relay, broker } = makeRelayForIdle({ handoffStatus: "pending" });
		await relay.checkIdleActions();
		await relay.checkIdleActions();
		expect(broker.control.acceptRelayHandoff).toHaveBeenCalledTimes(1);
	});
});

describe("checkIdleActions: autonomous mode", () => {
	// In autonomous mode (workflow=running, chain=active), the broker has no PTY
	// handle — only the mounted CLI process can inject text into the pane. Idle
	// auto-accept and auto-handback must therefore fire for autonomous handoffs
	// just like manual ones; the orchestrator evaluates verdicts after handback.
	it("auto-accepts a pending autonomous handoff", async () => {
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "pending",
			autonomous: true,
		});
		await relay.checkIdleActions();
		expect(broker.control.acceptRelayHandoff).toHaveBeenCalledWith({
			handoffId: "handoff_idle_1",
			acceptedAt: expect.any(String),
		});
	});

	it("auto-handbacks an accepted autonomous handoff once age >= 30s", async () => {
		const result = "implement approved plan keep commits small verify tests pass";
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			autonomous: true,
			handoffAgeMs: 35_000,
			captureHandbackText: async () => result,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => true),
				extractLatestAssistantTurn: vi.fn(() => ({
					confidence: "high" as const,
					text: result,
				})),
			},
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({ captureStatus: "ok", requestText: result }),
		);
	});
});

describe("checkIdleActions: auto-handback captureStatus", () => {
	it("calls finishAssistantTurn before extractLatestAssistantTurn so streaming output is classified correctly", async () => {
		const finishAssistantTurn = vi.fn();
		const extractLatestAssistantTurn = vi.fn(() => ({
			confidence: "low" as const,
			text: null,
		}));
		const { relay } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => null,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn,
				hasVisibleAssistantTurn: vi.fn(() => false),
				extractLatestAssistantTurn,
			},
		});
		await relay.checkIdleActions();
		const finishCallOrder = finishAssistantTurn.mock.invocationCallOrder[0];
		const extractCallOrder = extractLatestAssistantTurn.mock.invocationCallOrder[0];
		expect(finishCallOrder).toBeLessThan(extractCallOrder!);
	});

	it("calls handoffBackRelay with captureStatus ok when high confidence and jaccard >= 0.6", async () => {
		const result = "implement approved plan keep commits small verify tests pass";
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => result,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => true),
				extractLatestAssistantTurn: vi.fn(() => ({ confidence: "high" as const, text: result })),
			},
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({ captureStatus: "ok", requestText: result }),
		);
	});

	it("calls handoffBackRelay with no_response_captured when both signals empty", async () => {
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => null,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => false),
				extractLatestAssistantTurn: vi.fn(() => ({ confidence: "low" as const, text: null })),
			},
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({ captureStatus: "no_response_captured", requestText: "" }),
		);
	});

	it("calls handoffBackRelay with no_response_captured_confidently when jaccard < 0.6 and containment < 0.8", async () => {
		// Completely different vocabulary: no words overlap between clip and turn
		const turnText = "zebra monkey banana orange apple grape lemon melon";
		const clipText = "implement approve commit verify tests pass done";
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => clipText,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => true),
				extractLatestAssistantTurn: vi.fn(() => ({
					confidence: "high" as const,
					text: turnText,
				})),
			},
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				captureStatus: "no_response_captured_confidently",
				requestText: "",
			}),
		);
	});

	it("does not fire auto-handback twice for same handoffId", async () => {
		const result = "implement approved plan keep commits small";
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => result,
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => true),
				extractLatestAssistantTurn: vi.fn(() => ({ confidence: "high" as const, text: result })),
			},
		});
		await relay.checkIdleActions();
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledTimes(1);
	});

	it("does not call handoffBackRelay when isPausedInput returns true", async () => {
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			isPausedInput: () => true,
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});

	it("treats captureHandbackText exception as null clipboard and still calls handoffBackRelay", async () => {
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => {
				throw new Error("clipboard timeout");
			},
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => false),
				extractLatestAssistantTurn: vi.fn(() => ({ confidence: "low" as const, text: null })),
			},
		});
		await relay.checkIdleActions();
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({ captureStatus: "no_response_captured" }),
		);
	});

	it("when clipboard throws and turn capture has high-confidence text, captureStatus is no_response_captured_confidently", async () => {
		// Validates that turn extraction runs OUTSIDE the clipboard try/catch.
		// If finishAssistantTurn/extractLatestAssistantTurn were inside the try, a clipboard
		// exception would leave turnResult as {low, null}, producing no_response_captured instead.
		const { relay, broker } = makeRelayForIdle({
			handoffStatus: "accepted",
			captureHandbackText: async () => {
				throw new Error("clipboard timeout");
			},
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				hasVisibleAssistantTurn: vi.fn(() => true),
				extractLatestAssistantTurn: vi.fn(() => ({
					confidence: "high" as const,
					text: "implement approved plan keep commits small verify tests pass",
				})),
			},
		});
		await relay.checkIdleActions();
		// clipboard null → Jaccard check cannot pass → no_response_captured_confidently (not no_response_captured)
		expect(broker.control.handoffBackRelay).toHaveBeenCalledWith(
			expect.objectContaining({
				captureStatus: "no_response_captured_confidently",
				requestText: "",
			}),
		);
	});

	it("aborts silently when the accepted handoff is replaced before handback (race guard)", async () => {
		let resolveCapture!: (v: string | null) => void;
		const capturePromise = new Promise<string | null>((r) => {
			resolveCapture = r;
		});

		const acceptedHandoff = {
			handoffId: "handoff_race_1",
			collabId: "collab_idle",
			senderAgent: "codex" as const,
			targetAgent: "claude" as const,
			requestText: "work",
			status: "accepted" as const,
		};

		const broker = {
			control: {
				getRelayTurnState: vi.fn(() => ({
					collabId: "collab_idle",
					turnOwner: "claude" as const,
					waitingAgent: "codex" as const,
					unresolvedHandoffId: "handoff_race_1",
					handoffState: "accepted" as const,
					handoffAgeMs: 5_000,
				})),
				// First call returns the accepted handoff; subsequent calls return a DIFFERENT handoff
				// (simulating the original handoff being resolved and a new one appearing mid-capture)
				getRelayHandoff: vi
					.fn()
					.mockReturnValueOnce(acceptedHandoff)
					.mockReturnValueOnce(acceptedHandoff)
					.mockReturnValue({
						...acceptedHandoff,
						handoffId: "handoff_race_2",
						status: "accepted" as const,
					}),
				acceptRelayHandoff: vi.fn(),
				declineRelayHandoff: vi.fn(),
				deferRelayHandoff: vi.fn(),
				markRelayHandoffStale: vi.fn(),
				handoffBackRelay: vi.fn(),
			},
		};

		const relay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_idle",
			currentAgent: "claude",
			writeLocalMessage: vi.fn(),
			writeUserInput: vi.fn(),
			openComposer: vi.fn(),
			captureHandbackText: () => capturePromise,
		});

		const actionPromise = relay.checkIdleActions();
		resolveCapture("some result");
		await actionPromise;

		// handoffId no longer matches — must not hand back
		expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
	});
});
