import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";

describe("broker collaboration engine", () => {
	it("simulates both sides of a collaboration through broker control operations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-collab-"));
		const runtime = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		const collab = runtime.control.startCollab({
			collabId: "collab_phase3",
			workspaceRoot: "/tmp/ai-whisper",
			displayName: "phase3",
			now: "2026-04-03T00:00:00.000Z",
		});

		runtime.control.registerSession({
			sessionId: "session_claude_1",
			collabId: collab.collabId,
			agentType: "claude",
			now: "2026-04-03T00:00:01.000Z",
			capabilities: {
				supportsDirectPackets: true,
			},
		});

		runtime.control.registerSession({
			sessionId: "session_codex_1",
			collabId: collab.collabId,
			agentType: "codex",
			now: "2026-04-03T00:00:02.000Z",
			capabilities: {
				supportsDirectPackets: true,
			},
		});

		const thread = runtime.control.createThread({
			threadId: "thread_phase3",
			collabId: collab.collabId,
			title: "Review architecture",
			createdBySessionId: "session_claude_1",
			now: "2026-04-03T00:00:03.000Z",
		});

		const manifest = runtime.control.attachArtifactManifest({
			artifactManifestId: "manifest_phase3",
			threadId: thread.threadId,
			collabId: collab.collabId,
			producedBySessionId: "session_claude_1",
			artifactCategory: "plan_doc",
			entries: [
				{
					path: "docs/superpowers/specs/example.md",
					kind: "file",
				},
			],
			summary: "Approved plan",
			ownerType: "thread",
			ownerId: thread.threadId,
			now: "2026-04-03T00:00:04.000Z",
		});

		const workItem = runtime.control.enqueueWorkItem({
			workItemId: "work_phase3",
			threadId: thread.threadId,
			collabId: collab.collabId,
			senderSessionId: "session_claude_1",
			targetSessionId: "session_codex_1",
			requestedAction: "review_plan",
			instruction: "Review the approved architecture plan.",
			contextPacket: {
				kind: "full",
				goal: "Review the architecture plan",
				currentState: "Plan approved",
				decisionsMade: ["Use local broker"],
				assumptions: ["Single workspace"],
				relevantArtifacts: [manifest.artifactManifestId],
				openQuestions: [],
				successCriteria: ["Return findings"],
			},
			artifactManifestIds: [manifest.artifactManifestId],
			now: "2026-04-03T00:00:05.000Z",
		});

		runtime.control.ackWorkItemDelivered({
			workItemId: workItem.workItemId,
			deliveredAt: "2026-04-03T00:00:06.000Z",
		});

		const reply = runtime.control.postReply({
			replyId: "reply_phase3",
			threadId: thread.threadId,
			collabId: collab.collabId,
			workItemId: workItem.workItemId,
			sourceSessionId: "session_codex_1",
			kind: "review",
			content: "The plan is missing explicit replay validation details.",
			transitionIntent: "awaiting_user",
			artifactManifestIds: [],
			now: "2026-04-03T00:00:07.000Z",
		});

		expect(reply.kind).toBe("review");
		expect(runtime.control.getThread(thread.threadId)?.threadState).toBe(
			"awaiting_user",
		);
		expect(runtime.control.listThreads(collab.collabId)).toHaveLength(1);
		expect(runtime.control.listEventsForCollab(collab.collabId)).toHaveLength(
			9,
		);

		await runtime.stop();
	});
});
