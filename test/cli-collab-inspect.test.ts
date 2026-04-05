import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { formatInspectSnapshot, truncatePreview } from "../packages/cli/src/runtime/operator-inspect.ts";

describe("inspect broker data access", () => {
	it("lists work items for the active thread in chronological order", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		const now = "2026-04-06T09:00:00.000Z";

		runtime.control.startCollab({
			collabId: "collab_inspect_data",
			workspaceRoot: "/tmp/workspace",
			displayName: "inspect",
			now,
		});
		runtime.control.registerSession({
			sessionId: "session_codex",
			collabId: "collab_inspect_data",
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		runtime.control.registerSession({
			sessionId: "session_claude",
			collabId: "collab_inspect_data",
			agentType: "claude",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		runtime.control.createThread({
			threadId: "thread_active",
			collabId: "collab_inspect_data",
			title: "Review plan",
			createdBySessionId: "session_codex",
			now,
		});
		runtime.control.enqueueWorkItem({
			workItemId: "work_1",
			threadId: "thread_active",
			collabId: "collab_inspect_data",
			senderSessionId: "session_codex",
			targetSessionId: "session_claude",
			requestedAction: "review_plan",
			instruction: "review docs/plan.md",
			contextPacket: {
				kind: "full",
				goal: "review docs/plan.md",
				currentState: "starting",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			now: "2026-04-06T09:00:10.000Z",
		});

		const workItems = runtime.control.listWorkItems("thread_active");
		expect(workItems.map((item) => item.workItemId)).toEqual(["work_1"]);
	});
});

describe("operator inspect renderer", () => {
	it("truncates long reply content in compact mode", () => {
		expect(truncatePreview("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcdefghi...");
	});

	it("renders compact snapshot sections in a stable order", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_123",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{ agentType: "codex", bindingState: "bound", healthState: "healthy" },
				{ agentType: "claude", bindingState: "bound", healthState: "degraded" },
			],
			activeThread: {
				threadId: "thread_1",
				title: "Review plan",
				threadState: "in_progress",
				currentTurnIndex: 4,
			},
			workItems: [
				{
					workItemId: "work_4",
					turnIndex: 4,
					senderRole: "codex",
					targetRole: "claude",
					requestedAction: "review_plan",
					deliveryState: "queued",
					instructionPreview: "review docs/plan.md",
				},
			],
			replies: [
				{
					replyId: "reply_4",
					sourceRole: "claude",
					kind: "review",
					transitionIntent: "in_progress",
					contentPreview: "Looks good overall...",
				},
			],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-06T09:30:00.000Z",
		});

		expect(output).toContain("Collab: collab_123");
		expect(output).toContain("Active Thread: Review plan");
		expect(output).toContain("Recent Work Items");
		expect(output).toContain("Recent Replies");
	});
});
