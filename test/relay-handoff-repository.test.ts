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
