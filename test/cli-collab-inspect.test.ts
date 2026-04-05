import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

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
