import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createSessionId } from "../packages/shared/src/index.ts";

describe("reply consumed tracking", () => {
	function setupBrokerWithThread() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-consumed-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		const codexSession = createSessionId("session_codex");
		const claudeSession = createSessionId("session_claude");

		broker.control.registerSession({
			sessionId: codexSession,
			collabId: "collab_1",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-06T00:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: claudeSession,
			collabId: "collab_1",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.setSessionBinding({
			collabId: "collab_1",
			agentType: "codex",
			sessionId: codexSession,
			bindingSource: "launched",
			now: "2026-04-06T00:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_1",
			agentType: "claude",
			sessionId: claudeSession,
			bindingSource: "launched",
			now: "2026-04-06T00:00:00.000Z",
		});

		const thread = broker.control.createThread({
			threadId: "thread_test1",
			collabId: "collab_1",
			title: "test thread",
			createdBySessionId: codexSession,
			now: "2026-04-06T00:00:00.000Z",
		});

		return { broker, codexSession, claudeSession, thread };
	}

	it("lists unconsumed replies for a target session", () => {
		const { broker, codexSession, claudeSession, thread } = setupBrokerWithThread();

		broker.control.enqueueWorkItem({
			workItemId: "work_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			senderSessionId: claudeSession,
			targetSessionId: codexSession,
			requestedAction: "review_diff",
			instruction: "review the implementation",
			contextPacket: { kind: "full", goal: "review", currentState: "reviewing", decisionsMade: [], assumptions: [], relevantArtifacts: [], openQuestions: [], successCriteria: [] },
			now: "2026-04-06T00:01:00.000Z",
		});

		broker.control.postReply({
			replyId: "reply_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			workItemId: "work_1",
			sourceSessionId: codexSession,
			kind: "review",
			content: "Found 3 issues",
			transitionIntent: "completed",
			artifactManifestIds: [],
			now: "2026-04-06T00:02:00.000Z",
		});

		// Reply should be unconsumed by claude
		const unconsumed = broker.control.listUnconsumedReplies({
			collabId: "collab_1",
			threadId: thread.threadId,
			forSessionId: claudeSession,
		});
		expect(unconsumed).toHaveLength(1);
		expect(unconsumed[0].content).toBe("Found 3 issues");

		// Mark as consumed
		broker.control.markRepliesConsumed({
			replyIds: ["reply_1"],
			consumedBySessionId: claudeSession,
		});

		// Now should be empty
		const afterConsume = broker.control.listUnconsumedReplies({
			collabId: "collab_1",
			threadId: thread.threadId,
			forSessionId: claudeSession,
		});
		expect(afterConsume).toHaveLength(0);
	});

	it("does not return replies sent by the requesting session", () => {
		const { broker, codexSession, claudeSession, thread } = setupBrokerWithThread();

		broker.control.enqueueWorkItem({
			workItemId: "work_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			senderSessionId: claudeSession,
			targetSessionId: codexSession,
			requestedAction: "answer_question",
			instruction: "test",
			contextPacket: { kind: "full", goal: "test", currentState: "testing", decisionsMade: [], assumptions: [], relevantArtifacts: [], openQuestions: [], successCriteria: [] },
			now: "2026-04-06T00:01:00.000Z",
		});

		// Codex replies
		broker.control.postReply({
			replyId: "reply_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			workItemId: "work_1",
			sourceSessionId: codexSession,
			kind: "answer",
			content: "the answer",
			transitionIntent: "completed",
			artifactManifestIds: [],
			now: "2026-04-06T00:02:00.000Z",
		});

		// Codex should NOT see its own reply as unconsumed
		const forCodex = broker.control.listUnconsumedReplies({
			collabId: "collab_1",
			threadId: thread.threadId,
			forSessionId: codexSession,
		});
		expect(forCodex).toHaveLength(0);

		// Claude SHOULD see it
		const forClaude = broker.control.listUnconsumedReplies({
			collabId: "collab_1",
			threadId: thread.threadId,
			forSessionId: claudeSession,
		});
		expect(forClaude).toHaveLength(1);
	});
});
