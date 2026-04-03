import { describe, expect, it } from "vitest";
import {
	artifactManifestSchema,
	collabSchema,
	createArtifactManifestId,
	createReplyId,
	createSessionId,
	createThreadId,
	createWorkItemId,
	fullContextPacketSchema,
	replySchema,
	sessionSchema,
	threadSchema,
	workItemSchema,
} from "../packages/shared/src/index.ts";

describe("concrete collaboration schemas", () => {
	it("validates the core collaboration entities", () => {
		expect(
			collabSchema.parse({
				version: 1,
				collabId: "collab_phase3",
				workspaceRoot: "/tmp/ai-whisper",
				displayName: "phase3",
				status: "active",
				createdAt: "2026-04-03T00:00:00.000Z",
				updatedAt: "2026-04-03T00:00:00.000Z",
			}).collabId,
		).toBe("collab_phase3");

		expect(
			sessionSchema.parse({
				version: 1,
				sessionId: createSessionId("session_codex_1"),
				collabId: "collab_phase3",
				agentType: "codex",
				registrationState: "registered",
				healthState: "healthy",
				capabilities: {
					supportsDirectPackets: true,
				},
				registeredAt: "2026-04-03T00:00:00.000Z",
				lastSeenAt: "2026-04-03T00:00:00.000Z",
			}).agentType,
		).toBe("codex");

		expect(
			threadSchema.parse({
				version: 1,
				threadId: createThreadId("thread_phase3"),
				collabId: "collab_phase3",
				title: "Review architecture",
				threadState: "in_progress",
				baseContextRef: null,
				currentTurnIndex: 1,
				active: true,
				createdBySessionId: createSessionId("session_claude_1"),
				createdAt: "2026-04-03T00:00:00.000Z",
				updatedAt: "2026-04-03T00:00:00.000Z",
			}).title,
		).toBe("Review architecture");

		expect(
			workItemSchema.parse({
				version: 1,
				workItemId: createWorkItemId("work_phase3"),
				threadId: createThreadId("thread_phase3"),
				collabId: "collab_phase3",
				turnIndex: 1,
				senderSessionId: createSessionId("session_claude_1"),
				targetSessionId: createSessionId("session_codex_1"),
				requestedAction: "review_plan",
				instruction: "Review the approved plan.",
				contextPacket: fullContextPacketSchema.parse({
					kind: "full",
					goal: "Review the plan",
					currentState: "Plan drafted",
					decisionsMade: ["Use broker-first design"],
					assumptions: ["Local-only runtime"],
					relevantArtifacts: [],
					openQuestions: [],
					successCriteria: ["Return findings"],
				}),
				deliveryState: "queued",
				artifactManifestIds: [],
				createdAt: "2026-04-03T00:00:00.000Z",
				deliveredAt: null,
				completedAt: null,
			}).requestedAction,
		).toBe("review_plan");

		expect(
			replySchema.parse({
				version: 1,
				replyId: createReplyId("reply_phase3"),
				threadId: createThreadId("thread_phase3"),
				collabId: "collab_phase3",
				workItemId: createWorkItemId("work_phase3"),
				sourceSessionId: createSessionId("session_codex_1"),
				turnIndex: 1,
				kind: "review",
				content: "The plan is missing retry policy details.",
				transitionIntent: "awaiting_user",
				artifactManifestIds: [],
				createdAt: "2026-04-03T00:00:00.000Z",
			}).kind,
		).toBe("review");

		expect(
			artifactManifestSchema.parse({
				version: 1,
				artifactManifestId: createArtifactManifestId("manifest_phase3"),
				threadId: createThreadId("thread_phase3"),
				collabId: "collab_phase3",
				producedBySessionId: createSessionId("session_codex_1"),
				artifactCategory: "design_doc",
				entries: [
					{
						path: "docs/spec.md",
						kind: "file",
					},
				],
				summary: "Architecture review inputs",
				createdAt: "2026-04-03T00:00:00.000Z",
			}).artifactCategory,
		).toBe("design_doc");
	});
});
