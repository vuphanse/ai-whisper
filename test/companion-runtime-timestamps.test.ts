import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createCompanionRuntime } from "../packages/companion-core/src/create-companion-runtime.ts";
import { createSessionId } from "../packages/shared/src/index.ts";

describe("companion runtime timestamps", () => {
	const runtimes: Array<ReturnType<typeof createBrokerRuntime>> = [];

	afterEach(() => {
		vi.useRealTimers();
		for (const runtime of runtimes) {
			runtime.db.close();
		}
		runtimes.length = 0;
	});

	it("timestamps replies when provider work completes, not when polling starts", async () => {
		vi.useFakeTimers();

		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-companion-time-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const broker = createBrokerRuntime({
			sqlitePath,
			host: "127.0.0.1",
			port: 4311,
		});
		runtimes.push(broker);

		broker.control.startCollab({
			collabId: "collab_companion_time",
			workspaceRoot,
			displayName: "companion-time",
			now: "2026-04-05T09:35:07.000Z",
		});
		const claudeSessionId = createSessionId("session_claude_companion_time");
		const codexSessionId = createSessionId("session_codex_companion_time");
		broker.control.registerSession({
			sessionId: claudeSessionId,
			collabId: "collab_companion_time",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-05T09:35:07.100Z",
		});
		broker.control.registerSession({
			sessionId: codexSessionId,
			collabId: "collab_companion_time",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-05T09:35:07.200Z",
		});

		broker.control.setSessionBinding({
			collabId: "collab_companion_time",
			agentType: "codex",
			sessionId: codexSessionId,
			bindingSource: "launched",
			now: "2026-04-05T09:35:07.200Z",
		});

		const companion = createCompanionRuntime({
			broker,
			collabId: "collab_companion_time",
			sessionId: codexSessionId,
			provider: {
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
				handleWork() {
					return new Promise((resolve) => {
						setTimeout(() => {
							resolve({
								kind: "answer" as const,
								content: "done",
								transitionIntent: "completed" as const,
							});
						}, 45_000);
					});
				},
			},
		});

		companion.register("2026-04-05T09:35:07.300Z");
		const thread = broker.control.createThread({
			threadId: "thread_companion_time",
			collabId: "collab_companion_time",
			title: "Companion timing",
			createdBySessionId: claudeSessionId,
			now: "2026-04-05T09:35:07.400Z",
		});
		broker.control.enqueueWorkItem({
			workItemId: "work_companion_time",
			threadId: thread.threadId,
			collabId: "collab_companion_time",
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
			now: "2026-04-05T09:35:07.500Z",
		});

		const pending = companion.processNext("2026-04-05T09:35:07.600Z");
		await vi.advanceTimersByTimeAsync(45_000);
		const reply = await pending;

		expect(reply?.createdAt).not.toBe("2026-04-05T09:35:07.600Z");
		expect(Date.parse(reply?.createdAt ?? "")).toBeGreaterThan(
			Date.parse("2026-04-05T09:35:07.600Z"),
		);
	});
});
