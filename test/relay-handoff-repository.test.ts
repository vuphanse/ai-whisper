import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function createTestBroker() {
	return createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
}

type TestBroker = ReturnType<typeof createTestBroker>;

function setupOrchestratedChain(
	broker: TestBroker,
	overrides: {
		collabId?: string;
		handoffId?: string;
		senderAgent?: "codex" | "claude";
		targetAgent?: "codex" | "claude";
		requestText?: string;
	} = {},
) {
	const collabId = overrides.collabId ?? "collab_chain";
	const handoffId = overrides.handoffId ?? "handoff_root";
	const senderAgent = overrides.senderAgent ?? "codex";
	const targetAgent = overrides.targetAgent ?? "claude";
	const requestText = overrides.requestText ?? "Review spec";

	broker.control.startCollab({
		collabId,
		workspaceRoot: "/tmp/test",
		displayName: "chain",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: "2026-04-11T00:00:00.000Z",
	});

	broker.control.createRelayHandoff({
		handoffId,
		collabId,
		senderAgent,
		targetAgent,
		requestText,
		now: "2026-04-11T00:00:05.000Z",
	});

	broker.control.acceptRelayHandoff({
		handoffId,
		acceptedAt: "2026-04-11T00:00:10.000Z",
	});

	broker.control.handoffBackRelay({
		handoffId,
		nextHandoffId: `${handoffId}_next_ignored`,
		senderAgent: targetAgent,
		targetAgent: senderAgent,
		requestText: "Work done",
		now: "2026-04-11T00:01:00.000Z",
	});
}

function setupClaimedHandedBackHandoff(
	broker: TestBroker,
	overrides: {
		handoffId?: string;
		collabId?: string;
		senderAgent?: "codex" | "claude";
		targetAgent?: "codex" | "claude";
		requestText?: string;
		rootRequestText?: string;
		handbackText?: string;
		captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured";
	} = {},
) {
	const handoffId = overrides.handoffId ?? "handoff_root";

	setupOrchestratedChain(broker, {
		collabId: overrides.collabId ?? "collab_chain",
		handoffId,
		senderAgent: overrides.senderAgent ?? "codex",
		targetAgent: overrides.targetAgent ?? "claude",
		requestText: overrides.requestText ?? "Review spec",
	});

	broker.control.claimRelayHandoffForOrchestration({
		handoffId,
		claimedAt: "2026-04-11T00:01:30.000Z",
	});
}

describe("relay handoff repository", () => {
	it("accepts, defers, marks stale, declines, and releases the sender", () => {
		const broker = createTestBroker();

		broker.control.startCollab({
			collabId: "collab_handoff",
			workspaceRoot: "/tmp/test",
			displayName: "handoff",
			now: "2026-04-08T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_1",
			collabId: "collab_handoff",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Implement the plan",
			now: "2026-04-08T00:00:05.000Z",
		});

		broker.control.acceptRelayHandoff({
			handoffId: "handoff_1",
			acceptedAt: "2026-04-08T00:00:10.000Z",
		});
		broker.control.deferRelayHandoff({
			handoffId: "handoff_1",
			deferredAt: "2026-04-08T00:05:10.000Z",
		});
		broker.control.markRelayHandoffStale({
			handoffId: "handoff_1",
			now: "2026-04-08T00:10:10.000Z",
		});
		broker.control.declineRelayHandoff({
			handoffId: "handoff_1",
			now: "2026-04-08T00:10:20.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_handoff")).toEqual(
			expect.objectContaining({
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
			}),
		);
	});

	it("handoffBackRelay marks old handoff handed_back, creates next handoff, and flips turn ownership", () => {
		const broker = createTestBroker();

		broker.control.startCollab({
			collabId: "collab_handoff_back",
			workspaceRoot: "/tmp/test",
			displayName: "handoff-back",
			now: "2026-04-08T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_orig",
			collabId: "collab_handoff_back",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Implement the plan",
			now: "2026-04-08T00:00:05.000Z",
		});

		broker.control.acceptRelayHandoff({
			handoffId: "handoff_orig",
			acceptedAt: "2026-04-08T00:00:10.000Z",
		});

		broker.control.handoffBackRelay({
			handoffId: "handoff_orig",
			nextHandoffId: "handoff_next",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "Review my work",
			now: "2026-04-08T00:01:00.000Z",
		});

		// Old handoff must be marked handed_back
		expect(broker.control.getRelayHandoff("handoff_orig")?.status).toBe("handed_back");

		// Turn state must reflect the new owner and point to the new handoff
		expect(broker.control.getRelayTurnState("collab_handoff_back")).toEqual(
			expect.objectContaining({
				turnOwner: "codex",
				waitingAgent: "claude",
				handoffState: "pending",
				unresolvedHandoffId: "handoff_next",
			}),
		);

		// New handoff must exist and be pending
		expect(broker.control.getRelayHandoff("handoff_next")).toEqual(
			expect.objectContaining({
				handoffId: "handoff_next",
				collabId: "collab_handoff_back",
				senderAgent: "claude",
				targetAgent: "codex",
				requestText: "Review my work",
				status: "pending",
			}),
		);
	});

	it("handoffBackRelay stores captureStatus on the handed-back record, not on the next pending record", () => {
		const broker = createTestBroker();

		broker.control.startCollab({
			collabId: "collab_capture",
			workspaceRoot: "/tmp/test",
			displayName: "capture",
			now: "2026-04-10T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_cs_1",
			collabId: "collab_capture",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Do the work",
			now: "2026-04-10T00:00:05.000Z",
		});

		broker.control.acceptRelayHandoff({
			handoffId: "handoff_cs_1",
			acceptedAt: "2026-04-10T00:00:10.000Z",
		});

		broker.control.handoffBackRelay({
			handoffId: "handoff_cs_1",
			nextHandoffId: "handoff_cs_2",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "Here is the result",
			captureStatus: "ok",
			now: "2026-04-10T00:01:00.000Z",
		});

		// captureStatus on the completed (handed_back) record
		expect(broker.control.getRelayHandoff("handoff_cs_1")?.captureStatus).toBe("ok");
		// new pending record has null captureStatus — it hasn't been worked on yet
		expect(broker.control.getRelayHandoff("handoff_cs_2")?.captureStatus).toBeNull();
	});

	it("getLatestHandedBackHandoff returns the most recently handed-back record, not the first", () => {
		const broker = createTestBroker();

		broker.control.startCollab({
			collabId: "collab_latest",
			workspaceRoot: "/tmp/test",
			displayName: "latest",
			now: "2026-04-10T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_latest_1",
			collabId: "collab_latest",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Do the work",
			now: "2026-04-10T00:00:05.000Z",
		});

		broker.control.acceptRelayHandoff({
			handoffId: "handoff_latest_1",
			acceptedAt: "2026-04-10T00:00:10.000Z",
		});

		// First round back — captureStatus "ok"
		broker.control.handoffBackRelay({
			handoffId: "handoff_latest_1",
			nextHandoffId: "handoff_latest_2",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "Here is the first result",
			captureStatus: "ok",
			now: "2026-04-10T00:01:00.000Z",
		});

		broker.control.acceptRelayHandoff({
			handoffId: "handoff_latest_2",
			acceptedAt: "2026-04-10T00:01:10.000Z",
		});

		// Second round back — captureStatus "no_response_captured_confidently"
		broker.control.handoffBackRelay({
			handoffId: "handoff_latest_2",
			nextHandoffId: "handoff_latest_3",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Here is the second result",
			captureStatus: "no_response_captured_confidently",
			now: "2026-04-10T00:02:00.000Z",
		});

		const latest = broker.control.getLatestHandedBackHandoff("collab_latest");
		// Must return the second (most recent) handed_back record
		expect(latest?.handoffId).toBe("handoff_latest_2");
		expect(latest?.captureStatus).toBe("no_response_captured_confidently");

		// Unrelated collab returns null
		expect(broker.control.getLatestHandedBackHandoff("other_collab")).toBeNull();
	});

	it("stores chain metadata on the initial relay handoff", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_chain",
			workspaceRoot: "/tmp/test",
			displayName: "chain",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 3,
			now: "2026-04-11T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_root",
			collabId: "collab_chain",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Review docs/superpowers/specs/2026-04-09-relay-orchestrator-agent-design.md",
			now: "2026-04-11T00:00:05.000Z",
		});

		expect(broker.control.getRelayHandoff("handoff_root")).toEqual(
			expect.objectContaining({
				chainId: "handoff_root",
				parentHandoffId: null,
				roundNumber: 1,
				maxRounds: 3,
				rootRequestText: "Review docs/superpowers/specs/2026-04-09-relay-orchestrator-agent-design.md",
				handbackText: null,
				orchestratorStatus: "idle",
				orchestratorVerdict: null,
			}),
		);
	});

	it("marks unresolved handoff failed on owner disconnect and releases the sender", () => {
		const broker = createTestBroker();

		broker.control.startCollab({
			collabId: "collab_handoff",
			workspaceRoot: "/tmp/test",
			displayName: "handoff",
			now: "2026-04-08T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_1",
			collabId: "collab_handoff",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Implement the plan",
			now: "2026-04-08T00:00:05.000Z",
		});

		broker.control.failRelayHandoffOnDisconnect({
			handoffId: "handoff_1",
			now: "2026-04-08T00:00:20.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_handoff").turnOwner).toBe("none");
		expect(broker.control.getRelayHandoff("handoff_1")?.status).toBe("failed");
	});

	it("claims a handed-back handoff exactly once", () => {
		const broker = createTestBroker();
		setupOrchestratedChain(broker);

		const first = broker.control.claimRelayHandoffForOrchestration({
			handoffId: "handoff_root",
			claimedAt: "2026-04-11T00:01:00.000Z",
		});
		const second = broker.control.claimRelayHandoffForOrchestration({
			handoffId: "handoff_root",
			claimedAt: "2026-04-11T00:01:01.000Z",
		});

		expect(first?.orchestratorStatus).toBe("pending");
		expect(second).toBeNull();
	});

	it("re-issues unchanged request text on forced loop when captureStatus is unusable", () => {
		const broker = createTestBroker();
		setupClaimedHandedBackHandoff(broker, {
			handoffId: "handoff_root",
			requestText: "Review spec",
		});

		broker.control.createLoopRelayHandoff({
			handoffId: "handoff_root",
			nextHandoffId: "handoff_round_2",
			requestText: "Review spec",
			reason: "forced re-issue: no response captured",
			now: "2026-04-11T00:02:00.000Z",
		});

		expect(broker.control.getRelayHandoff("handoff_round_2")).toEqual(
			expect.objectContaining({
				senderAgent: "claude",
				targetAgent: "codex",
				parentHandoffId: "handoff_root",
				roundNumber: 2,
				requestText: "Review spec",
			}),
		);
		expect(broker.control.getRelayHandoff("handoff_root")).toEqual(
			expect.objectContaining({
				orchestratorStatus: "processed",
				orchestratorVerdict: "loop",
			}),
		);
	});

	it("creates LLM-reviewed loop handoffs with swapped agents and composed request text", () => {
		const broker = createTestBroker();
		setupClaimedHandedBackHandoff(broker, {
			handoffId: "handoff_root",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Review spec",
		});

		broker.control.createLoopRelayHandoff({
			handoffId: "handoff_root",
			nextHandoffId: "handoff_round_2",
			requestText:
				"Original request:\nReview spec\n\nLatest result:\nFound two issues in relay-orchestrator plan.\n\nFollow-up:\nFix retry handling and max-round enforcement.",
			reason: "reviewer found issues",
			now: "2026-04-11T00:02:00.000Z",
		});

		expect(broker.control.getRelayHandoff("handoff_round_2")).toEqual(
			expect.objectContaining({
				senderAgent: "claude",
				targetAgent: "codex",
				requestText:
					"Original request:\nReview spec\n\nLatest result:\nFound two issues in relay-orchestrator plan.\n\nFollow-up:\nFix retry handling and max-round enforcement.",
			}),
		);
	});

	it("marks unfinished chains abandoned during cleanup", () => {
		const broker = createTestBroker();
		setupClaimedHandedBackHandoff(broker, { handoffId: "handoff_root" });

		broker.control.markRelayChainAbandoned({
			handoffId: "handoff_root",
			reason: "collab ended before orchestration finished",
			evaluatedAt: "2026-04-11T00:03:00.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_chain").chainStatus).toBe("abandoned");
		expect(broker.control.getRelayHandoff("handoff_root")?.orchestratorVerdict).toBe("escalate");
	});
});
