import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function createTestBroker() {
	return createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
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
});
