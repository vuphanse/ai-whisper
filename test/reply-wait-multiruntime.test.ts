import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createSessionId } from "../packages/shared/src/index.ts";
import { waitForReply } from "../packages/cli/src/runtime/reply-wait.ts";

describe("waitForReply across broker runtimes", () => {
	const runtimes: Array<ReturnType<typeof createBrokerRuntime>> = [];

	afterEach(() => {
		for (const runtime of runtimes) {
			runtime.db.close();
		}
		runtimes.length = 0;
	});

	it("observes replies posted from a separate broker runtime on the same sqlite file", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-reply-wait-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const reader = createBrokerRuntime({
			sqlitePath,
			host: "127.0.0.1",
			port: 4311,
		});
		const writer = createBrokerRuntime({
			sqlitePath,
			host: "127.0.0.1",
			port: 4312,
		});
		runtimes.push(reader, writer);

		reader.control.startCollab({
			collabId: "collab_reply_wait",
			workspaceRoot,
			displayName: "reply-wait",
			now: "2026-04-05T09:35:07.000Z",
		});
		const claudeSessionId = createSessionId("session_claude_reply_wait");
		const codexSessionId = createSessionId("session_codex_reply_wait");
		reader.control.registerSession({
			sessionId: claudeSessionId,
			collabId: "collab_reply_wait",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-05T09:35:07.100Z",
		});
		reader.control.registerSession({
			sessionId: codexSessionId,
			collabId: "collab_reply_wait",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-05T09:35:07.200Z",
		});
		const thread = reader.control.createThread({
			threadId: "thread_reply_wait",
			collabId: "collab_reply_wait",
			title: "Reply wait thread",
			createdBySessionId: claudeSessionId,
			now: "2026-04-05T09:35:07.300Z",
		});
		const workItem = reader.control.enqueueWorkItem({
			workItemId: "work_reply_wait",
			threadId: thread.threadId,
			collabId: "collab_reply_wait",
			senderSessionId: claudeSessionId,
			targetSessionId: codexSessionId,
			requestedAction: "answer_question",
			instruction: "test from claude",
			contextPacket: {
				kind: "full",
				goal: "test from claude",
				currentState: "New thread",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			artifactManifestIds: [],
			now: "2026-04-05T09:35:07.400Z",
		});

		setTimeout(() => {
			writer.control.postReply({
				replyId: "reply_reply_wait",
				threadId: thread.threadId,
				collabId: "collab_reply_wait",
				workItemId: workItem.workItemId,
				sourceSessionId: codexSessionId,
				kind: "clarification",
				content: "Need a real question.",
				transitionIntent: "awaiting_user",
				artifactManifestIds: [],
				now: "2026-04-05T09:35:07.500Z",
			});
		}, 50);

		await expect(
			waitForReply({
				broker: reader,
				threadId: thread.threadId,
				workItemId: workItem.workItemId,
				timeoutMs: 500,
			}),
		).resolves.toMatchObject({
			kind: "clarification",
			content: "Need a real question.",
		});
	});
});
