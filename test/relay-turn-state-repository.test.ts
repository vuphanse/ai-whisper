import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function createTestBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-turn-owned-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "broker.sqlite"),
		host: "127.0.0.1",
		port: 4320,
	});
}

describe("relay turn state repository", () => {
	it("defaults to no owner and no unresolved handoff", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_turn",
			workspaceRoot: "/tmp/test",
			displayName: "turn-owned",
			now: "2026-04-08T00:00:00.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_turn")).toEqual({
			collabId: "collab_turn",
			turnOwner: "none",
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			handoffAgeMs: null,
			orchestratorEnabled: false,
			currentRound: 0,
			maxRounds: 3,
			chainStatus: "done",
		});
	});

	it("persists orchestrator config and exposes it through relay turn state", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_turn",
			workspaceRoot: "/tmp/test",
			displayName: "turn-owned",
			orchestratorEnabled: true,
			orchestratorMaxRounds: 4,
			now: "2026-04-11T00:00:00.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_turn")).toEqual({
			collabId: "collab_turn",
			turnOwner: "none",
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			handoffAgeMs: null,
			orchestratorEnabled: true,
			currentRound: 0,
			maxRounds: 4,
			chainStatus: "done",
		});
	});

	it("creates a handoff, flips ownership immediately, and rejects overlap", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_turn",
			workspaceRoot: "/tmp/test",
			displayName: "turn-owned",
			now: "2026-04-08T00:00:00.000Z",
		});

		const handoff = broker.control.createRelayHandoff({
			handoffId: "handoff_1",
			collabId: "collab_turn",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Execute the approved plan",
			now: "2026-04-08T00:00:05.000Z",
		});

		expect(handoff.status).toBe("pending");
		expect(broker.control.getRelayTurnState("collab_turn").turnOwner).toBe("claude");

		expect(() =>
			broker.control.createRelayHandoff({
				handoffId: "handoff_2",
				collabId: "collab_turn",
				senderAgent: "claude",
				targetAgent: "codex",
				requestText: "Review the diff",
				now: "2026-04-08T00:00:06.000Z",
			}),
		).toThrow(/unresolved handoff/i);
	});
});
