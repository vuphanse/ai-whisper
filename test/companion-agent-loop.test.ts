import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import type {
	CompanionProvider,
	InteractiveSessionController,
	ProviderWorkRequest,
} from "../packages/shared/src/index.ts";
import { createSessionId } from "../packages/shared/src/index.ts";
import { runCompanionAgentLoop } from "../packages/cli/src/runtime/companion-agent-loop.ts";

describe("companion agent loop", () => {
	it("drives broker work through an attached interactive session", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase6-loop-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const broker = createBrokerRuntime({
			sqlitePath,
			host: "127.0.0.1",
			port: 4311,
		});

		broker.control.startCollab({
			collabId: "collab_phase6",
			workspaceRoot,
			displayName: "phase6",
			now: "2026-04-04T02:00:00.000Z",
		});
		const codexSessionId = createSessionId("session_codex_phase6");
		const claudeSessionId = createSessionId("session_claude_phase6");
		broker.control.registerSession({
			sessionId: codexSessionId,
			collabId: "collab_phase6",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T02:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: claudeSessionId,
			collabId: "collab_phase6",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T02:00:00.000Z",
		});

		const handled: ProviderWorkRequest[] = [];
		const interactiveSession: InteractiveSessionController = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput() {},
			sendLocalMessage() {},
			runBrokerWork(request) {
				handled.push(request);
				return Promise.resolve({
					kind: "answer" as const,
					content: `handled ${request.instruction}`,
					transitionIntent: "completed" as const,
				});
			},
		};

		const provider: CompanionProvider = {
			getIdentity() {
				return {
					providerId: "test-provider",
					toolFamily: "codex",
					providerVersion: "1.0.0",
				};
			},
			getCapabilities() {
				return {
					supportsDirectPackets: true,
					supportsNormalization: true,
					supportsRelayInterception: true,
					supportsLocalBuffering: false,
					supportsLaunchHooks: true,
					extensions: {},
				};
			},
			getHealthState() {
				return "healthy";
			},
			attachInteractiveSession(session) {
				expect(session).toBe(interactiveSession);
			},
			async handleWork(request) {
				return interactiveSession.runBrokerWork(request);
			},
		};

		const stop = await runCompanionAgentLoop({
			broker,
			collabId: "collab_phase6",
			sessionId: codexSessionId,
			provider,
			interactiveSession,
			pollIntervalMs: 5,
		});

		const thread = broker.control.createThread({
			threadId: "thread_phase6",
			collabId: "collab_phase6",
			title: "Thread",
			createdBySessionId: claudeSessionId,
			now: "2026-04-04T02:00:01.000Z",
		});
		const workItem = broker.control.enqueueWorkItem({
			workItemId: "work_phase6",
			threadId: thread.threadId,
			collabId: "collab_phase6",
			senderSessionId: claudeSessionId,
			targetSessionId: codexSessionId,
			requestedAction: "answer_question",
			instruction: "status?",
			contextPacket: {
				kind: "full",
				goal: "status?",
				currentState: "New thread",
				decisionsMade: [],
				assumptions: [],
				relevantArtifacts: [],
				openQuestions: [],
				successCriteria: [],
			},
			artifactManifestIds: [],
			now: "2026-04-04T02:00:01.000Z",
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(handled).toHaveLength(1);
		expect(handled[0]?.workItemId).toBe(workItem.workItemId);
		expect(
			broker.control
				.listReplies(thread.threadId)
				.some((reply) => reply.workItemId === workItem.workItemId),
		).toBe(true);

		await stop();
	});
});
