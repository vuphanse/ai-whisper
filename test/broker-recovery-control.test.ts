import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { getWorkItem } from "../packages/broker/src/storage/repositories/work-item-repository.ts";

describe("broker recovery control", () => {
	it("revokes companion sessions, degrades bound roles, and blocks queued work on recovery", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({
			collabId: "collab_recovery",
			workspaceRoot: "/tmp/workspace",
			displayName: "recovery",
			now: "2026-04-05T15:58:00.000Z",
		});
		runtime.control.registerSession({
			sessionId: "session_codex_bound",
			collabId: "collab_recovery",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T15:58:00.000Z",
		});
		runtime.control.setSessionBinding({
			collabId: "collab_recovery",
			agentType: "codex",
			sessionId: "session_codex_bound",
			bindingSource: "attached",
			now: "2026-04-05T15:58:00.000Z",
		});
		const ack = runtime.control.registerCompanion({
			collabId: "collab_recovery",
			sessionId: "session_codex_bound",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T15:58:30.000Z",
		});
		runtime.control.createThread({
			threadId: "thread_recovery",
			collabId: "collab_recovery",
			title: "Recover me",
			createdBySessionId: "session_codex_bound",
			now: "2026-04-05T15:59:00.000Z",
		});
		runtime.control.enqueueWorkItem({
			workItemId: "work_recovery_1",
			threadId: "thread_recovery",
			collabId: "collab_recovery",
			senderSessionId: "session_codex_bound",
			targetSessionId: "session_codex_bound",
			requestedAction: "answer_question",
			instruction: "status?",
			contextPacket: {
				kind: "full",
				goal: "status?",
				currentState: "waiting",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			now: "2026-04-05T15:59:30.000Z",
		});

		runtime.control.prepareCollabRecovery({
			collabId: "collab_recovery",
			now: "2026-04-05T16:00:00.000Z",
		});

		expect(() =>
			runtime.control.pollQueuedWorkItem({
				collabId: "collab_recovery",
				sessionId: "session_codex_bound",
				sessionSecret: ack.sessionSecret,
			}),
		).toThrow(/invalid companion session secret/i);

		expect(
			runtime.control.listSessions("collab_recovery").find((s) => s.sessionId === "session_codex_bound")?.healthState,
		).toBe("degraded");

		expect(getWorkItem(runtime.db, "work_recovery_1")?.deliveryState).toBe("recovery_blocked");
	});
});
