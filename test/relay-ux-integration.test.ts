// test/relay-ux-integration.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createSessionId } from "../packages/shared/src/index.ts";
import { createRelayPaneWriter } from "../packages/cli/src/runtime/relay-pane-writer.ts";
import { createContextInjector } from "../packages/cli/src/runtime/context-injector.ts";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

describe("relay UX integration", () => {
	let dir: string | undefined;
	let broker: ReturnType<typeof createBrokerRuntime> | undefined;

	afterEach(async () => {
		if (broker) {
			await broker.stop();
			broker = undefined;
		}
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	it("full flow: directive → busy → response → context injection", () => {
		dir = mkdtempSync(join(tmpdir(), "ai-whisper-relay-ux-"));
		broker = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		// Setup collab
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: dir,
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		const codexSession = createSessionId("session_codex");
		const claudeSession = createSessionId("session_claude");
		broker.control.registerSession({ sessionId: codexSession, collabId: "collab_1", agentType: "codex", capabilities: { supportsDirectPackets: true }, now: "2026-04-06T00:00:00.000Z" });
		broker.control.registerSession({ sessionId: claudeSession, collabId: "collab_1", agentType: "claude", capabilities: { supportsDirectPackets: true }, now: "2026-04-06T00:00:00.000Z" });
		broker.control.setSessionBinding({ collabId: "collab_1", agentType: "codex", sessionId: codexSession, bindingSource: "launched", now: "2026-04-06T00:00:00.000Z" });
		broker.control.setSessionBinding({ collabId: "collab_1", agentType: "claude", sessionId: claudeSession, bindingSource: "launched", now: "2026-04-06T00:00:00.000Z" });

		// Register relay monitor
		broker.control.registerRelayMonitor({ collabId: "collab_1", monitorId: "monitor_1", now: "2026-04-06T00:00:00.000Z" });
		expect(broker.control.isRelayMonitorConnected("collab_1", "2026-04-06T00:00:05.000Z")).toBe(true);

		// 1. Write relay directive to relay pane
		const writer = createRelayPaneWriter({ broker, collabId: "collab_1" });
		writer.relayDirective({
			senderAgent: "claude",
			receiverAgent: "codex",
			instruction: "review the implementation",
			now: "2026-04-06T00:01:00.000Z",
		});

		// 2. Simulate codex completing the work — create thread, work item, reply
		const thread = broker.control.createThread({
			threadId: "thread_1",
			collabId: "collab_1",
			title: "review",
			createdBySessionId: claudeSession,
			now: "2026-04-06T00:01:00.000Z",
		});

		broker.control.enqueueWorkItem({
			workItemId: "work_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			senderSessionId: claudeSession,
			targetSessionId: codexSession,
			requestedAction: "review_diff",
			instruction: "review the implementation",
			contextPacket: { kind: "full", goal: "review", currentState: "pending review", decisionsMade: [], assumptions: [], relevantArtifacts: [], openQuestions: [], successCriteria: [] },
			now: "2026-04-06T00:01:00.000Z",
		});

		broker.control.postReply({
			replyId: "reply_1",
			threadId: thread.threadId,
			collabId: "collab_1",
			workItemId: "work_1",
			sourceSessionId: codexSession,
			kind: "review",
			content: "Found 3 issues:\n1) Missing error handling\n2) No validation\n3) Blocking IO",
			transitionIntent: "completed",
			artifactManifestIds: [],
			now: "2026-04-06T00:02:00.000Z",
		});

		// 3. Write relay response to relay pane
		writer.relayResponse({
			senderAgent: "codex",
			receiverAgent: "claude",
			content: "Found 3 issues:\n1) Missing error handling\n2) No validation\n3) Blocking IO",
			now: "2026-04-06T00:02:00.000Z",
		});

		// 4. Verify relay pane events — filter by type to avoid fragility from extra broker events
		const events = broker.control.pollRelayEvents("collab_1", 0);
		const directives = events.filter((e) => e.eventType === "relay_directive");
		const responses = events.filter((e) => e.eventType === "relay_response");
		expect(directives).toHaveLength(1);
		expect(responses).toHaveLength(1);
		expect(events.indexOf(directives[0]!)).toBeLessThan(events.indexOf(responses[0]!));

		// 5. Context injection — claude asks to fix findings
		const injector = createContextInjector({
			broker,
			collabId: "collab_1",
			sessionId: claudeSession,
		});

		const result = injector.injectContext({
			userInput: "Fix the findings from codex review",
			activeThreadId: thread.threadId,
		});

		expect(result.injected).toBe(true);
		expect(result.payload).toContain("[Context from recent relay exchange]");
		expect(result.payload).toContain("Found 3 issues");
		expect(result.payload).toContain("Fix the findings from codex review");

		// 6. Second injection should have nothing — replies already consumed
		const result2 = injector.injectContext({
			userInput: "anything else",
			activeThreadId: thread.threadId,
		});
		expect(result2.injected).toBe(false);
		expect(result2.payload).toBe("anything else");
		expect(result2.summary).toBeNull();
	});

	it("full flow: handoff → sender blocked → owner accept → handback", async () => {
		broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4323,
		});

		broker.control.startCollab({
			collabId: "collab_turn",
			workspaceRoot: "/tmp/test",
			displayName: "turn-owned",
			now: "2026-04-08T00:00:00.000Z",
		});

		broker.control.createRelayHandoff({
			handoffId: "handoff_1",
			collabId: "collab_turn",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "Implement the approved plan",
			now: "2026-04-08T00:00:05.000Z",
		});

		expect(broker.control.getRelayTurnState("collab_turn")).toEqual(
			expect.objectContaining({
				turnOwner: "claude",
				waitingAgent: "codex",
				handoffState: "pending",
			}),
		);

		const codexRelay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "codex",
			writeLocalMessage: vi.fn(),
			writeUserInput: vi.fn(),
			openComposer: ({ initialValue }: { initialValue: string }) => Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				extractLatestAssistantTurn: () => ({ confidence: "low" as const, text: null }),
			},
		});
		const claudeInjected: string[] = [];
		const claudeRelay = createMountedTurnOwnedRelay({
			broker,
			collabId: "collab_turn",
			currentAgent: "claude",
			writeLocalMessage: vi.fn(),
			writeUserInput(text: string) { claudeInjected.push(text); },
			openComposer: ({ initialValue }: { initialValue: string }) => Promise.resolve(initialValue),
			turnCapture: {
				reset: vi.fn(),
				finishAssistantTurn: vi.fn(),
				extractLatestAssistantTurn: () => ({ confidence: "high" as const, text: "Implemented the approved plan." }),
			},
		});

		expect(codexRelay.getWaitingGate().isBlocked()).toBe(true);

		await claudeRelay.acceptPendingHandoff();
		expect(claudeInjected.join("")).toContain("Implement the approved plan");

		await claudeRelay.handBackTo("codex");

		const turn = broker.control.getRelayTurnState("collab_turn");
		expect(turn.turnOwner).toBe("codex");
		expect(turn.waitingAgent).toBe("claude");

		expect(broker.control.getRelayTurnState("collab_turn")).toEqual(
			expect.objectContaining({
				turnOwner: "codex",
				waitingAgent: "claude",
				handoffState: "pending",
			}),
		);

		const nextHandoff = broker.control.getRelayHandoff(turn.unresolvedHandoffId!);
		expect(nextHandoff?.requestText).toContain("Implemented the approved plan.");
	});
});
