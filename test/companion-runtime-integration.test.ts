import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";
import { createCompanionRuntime } from "../packages/companion-core/src/create-companion-runtime.ts";
import { createMockProvider } from "../packages/companion-core/src/mock-provider.ts";

describe("companion runtime integration", () => {
	it("processes a queued work item through a registered mock provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase4-companion-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4313,
		});

		const collab = broker.control.startCollab({
			collabId: "collab_phase4",
			workspaceRoot: "/tmp/ai-whisper",
			displayName: "phase4",
			now: "2026-04-03T00:00:00.000Z",
		});

		broker.control.registerSession({
			sessionId: "session_claude_1",
			collabId: collab.collabId,
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-03T00:00:01.000Z",
		});

		broker.control.registerSession({
			sessionId: "session_codex_1",
			collabId: collab.collabId,
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-03T00:00:02.000Z",
		});

		const thread = broker.control.createThread({
			threadId: "thread_phase4",
			collabId: collab.collabId,
			title: "Review architecture",
			createdBySessionId: "session_claude_1",
			now: "2026-04-03T00:00:03.000Z",
		});

		broker.control.enqueueWorkItem({
			workItemId: "work_phase4",
			threadId: thread.threadId,
			collabId: collab.collabId,
			senderSessionId: "session_claude_1",
			targetSessionId: "session_codex_1",
			requestedAction: "review_plan",
			instruction: "Review the approved architecture plan.",
			contextPacket: {
				kind: "full",
				goal: "Review the architecture plan",
				currentState: "Approved",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			artifactManifestIds: [],
			now: "2026-04-03T00:00:04.000Z",
		});

		const companion = createCompanionRuntime({
			broker,
			collabId: collab.collabId,
			sessionId: "session_codex_1",
			provider: createMockProvider(),
		});

		companion.register("2026-04-03T00:00:05.000Z");
		const reply = await companion.processNext("2026-04-03T00:00:06.000Z");

		expect(reply?.kind).toBe("review");
		expect(reply?.transitionIntent).toBe("awaiting_user");
		expect(broker.control.getThread(thread.threadId)?.threadState).toBe(
			"awaiting_user",
		);
		expect(broker.control.listEventsForCollab(collab.collabId)).toHaveLength(8);

		await broker.stop();
	});
});
