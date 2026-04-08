import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("relay turn state guardrail", () => {
	it("keeps mounted relay handoff coverage out of the hidden executor loop", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4324,
		});

		broker.control.startCollab({
			collabId: "collab_legacy_loop",
			workspaceRoot: "/tmp/test",
			displayName: "legacy loop",
			now: "2026-04-08T00:00:00.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_legacy_loop")).toEqual({
			collabId: "collab_legacy_loop",
			turnOwner: "none",
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			handoffAgeMs: null,
		});
	});
});
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
		broker.control.setSessionBinding({
			collabId: "collab_phase6",
			agentType: "codex",
			sessionId: codexSessionId,
			bindingSource: "launched",
			now: "2026-04-04T02:00:00.000Z",
		});

		const handled: ProviderWorkRequest[] = [];
		const relayEvents: Array<{ type: string; [key: string]: unknown }> = [];
		const relayPaneWriter = {
			relayDirective(event: Record<string, unknown>) { relayEvents.push({ type: "directive", ...event }); },
			relayResponse(event: Record<string, unknown>) { relayEvents.push({ type: "response", ...event }); },
			status(event: Record<string, unknown>) { relayEvents.push({ type: "status", ...event }); },
			cancellation(event: Record<string, unknown>) { relayEvents.push({ type: "cancellation", ...event }); },
		};
		const interactiveSession: InteractiveSessionController = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput() {},
			sendLocalMessage() {},
			onExit() {},
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
			handleWork(request, context) {
				// Verify the executor passed an artifactHandle
				expect(context?.artifactHandle).toBeDefined();
				handled.push(request);
				return Promise.resolve({
					kind: "answer" as const,
					content: `handled ${request.instruction}`,
					transitionIntent: "completed" as const,
				});
			},
		};

		const stop = await runCompanionAgentLoop({
			broker,
			collabId: "collab_phase6",
			sessionId: codexSessionId,
			provider,
			interactiveSession,
			relayPaneWriter,
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
		expect(relayEvents.some((e) => e.type === "status" && String(e.content).includes("Received broker work"))).toBe(true);
		// relay_response is emitted by the origin side (waitForReply caller), not the loop

		await stop();
	});

	it("turns a broker cancellation request into a failure reply after delivery", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase6-loop-cancel-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const broker = createBrokerRuntime({
			sqlitePath,
			host: "127.0.0.1",
			port: 4311,
		});

		broker.control.startCollab({
			collabId: "collab_phase6_cancel",
			workspaceRoot,
			displayName: "phase6 cancel",
			now: "2026-04-06T02:00:00.000Z",
		});
		const codexSessionId = createSessionId("session_codex_phase6_cancel");
		const claudeSessionId = createSessionId("session_claude_phase6_cancel");
		broker.control.registerSession({
			sessionId: codexSessionId,
			collabId: "collab_phase6_cancel",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-06T02:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: claudeSessionId,
			collabId: "collab_phase6_cancel",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-06T02:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_phase6_cancel",
			agentType: "codex",
			sessionId: codexSessionId,
			bindingSource: "launched",
			now: "2026-04-06T02:00:00.000Z",
		});

		const relayEvents: Array<{ type: string; [key: string]: unknown }> = [];
		const relayPaneWriter = {
			relayDirective(event: Record<string, unknown>) { relayEvents.push({ type: "directive", ...event }); },
			relayResponse(event: Record<string, unknown>) { relayEvents.push({ type: "response", ...event }); },
			status(event: Record<string, unknown>) { relayEvents.push({ type: "status", ...event }); },
			cancellation(event: Record<string, unknown>) { relayEvents.push({ type: "cancellation", ...event }); },
		};
		const interactiveSession: InteractiveSessionController = {
			start: () => Promise.resolve(),
			stop: () => Promise.resolve(),
			writeUserInput() {},
			sendLocalMessage() {},
			onExit() {},
		};

		let resolveWork!: () => void;
		let workStarted = false;
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
			handleWork() {
				workStarted = true;
				return new Promise((resolve) => {
					resolveWork = () => {
						resolve({
							kind: "answer" as const,
							content: "handled after cancel",
							transitionIntent: "completed" as const,
						});
					};
				});
			},
		};

		const stop = await runCompanionAgentLoop({
			broker,
			collabId: "collab_phase6_cancel",
			sessionId: codexSessionId,
			provider,
			interactiveSession,
			relayPaneWriter,
			pollIntervalMs: 5,
		});

		const thread = broker.control.createThread({
			threadId: "thread_phase6_cancel",
			collabId: "collab_phase6_cancel",
			title: "Thread",
			createdBySessionId: claudeSessionId,
			now: "2026-04-06T02:00:01.000Z",
		});
		const workItem = broker.control.enqueueWorkItem({
			workItemId: "work_phase6_cancel",
			threadId: thread.threadId,
			collabId: "collab_phase6_cancel",
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
			now: "2026-04-06T02:00:01.000Z",
		});

		for (let attempts = 0; attempts < 20 && !workStarted; attempts += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(workStarted).toBe(true);

		broker.control.requestWorkItemCancellation({
			workItemId: workItem.workItemId,
			requestedAt: "2026-04-06T02:00:02.000Z",
		});
		resolveWork();

		await new Promise((resolve) => setTimeout(resolve, 50));

		const replies = broker.control
			.listReplies(thread.threadId)
			.filter((reply) => reply.workItemId === workItem.workItemId);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.kind).toBe("failure");
		expect(replies[0]?.content).toBe("Relay work cancelled by user");
		expect(relayEvents.some((e) => e.type === "cancellation")).toBe(true);

		await stop();
	});
});
