import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createSessionId } from "../packages/shared/src/index.ts";
import { enqueueRelayWork } from "../packages/cli/src/runtime/relay-service.ts";

describe("relay service", () => {
	it("reuses the active thread by default", () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-relay-service-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(workspaceRoot, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		broker.control.startCollab({
			collabId: "collab_phase6",
			workspaceRoot,
			displayName: "phase6",
			now: "2026-04-04T01:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: createSessionId("session_codex_phase6"),
			collabId: "collab_phase6",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T01:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: createSessionId("session_claude_phase6"),
			collabId: "collab_phase6",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T01:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_phase6",
			agentType: "codex",
			sessionId: createSessionId("session_codex_phase6"),
			bindingSource: "launched",
			now: "2026-04-04T01:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_phase6",
			agentType: "claude",
			sessionId: createSessionId("session_claude_phase6"),
			bindingSource: "launched",
			now: "2026-04-04T01:00:00.000Z",
		});
		const thread = broker.control.createThread({
			threadId: "thread_existing",
			collabId: "collab_phase6",
			title: "Existing thread",
			createdBySessionId: "session_codex_phase6",
			now: "2026-04-04T01:00:01.000Z",
		});

		const relay = enqueueRelayWork({
			broker,
			collabId: "collab_phase6",
			originSessionId: createSessionId("session_codex_phase6"),
			target: "claude",
			instruction: "answer this follow-up",
			artifactPaths: [],
			forceNewThread: false,
			now: "2026-04-04T01:00:02.000Z",
		});

		expect(relay.thread.threadId).toBe(thread.threadId);
		expect(relay.createdNewThread).toBe(false);
	});

	it("rejects new-thread review actions without artifacts", () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-relay-policy-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(workspaceRoot, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		broker.control.startCollab({
			collabId: "collab_phase6",
			workspaceRoot,
			displayName: "phase6",
			now: "2026-04-04T01:05:00.000Z",
		});
		broker.control.registerSession({
			sessionId: createSessionId("session_codex_phase6"),
			collabId: "collab_phase6",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T01:05:00.000Z",
		});
		broker.control.registerSession({
			sessionId: createSessionId("session_claude_phase6"),
			collabId: "collab_phase6",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true },
			now: "2026-04-04T01:05:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_phase6",
			agentType: "codex",
			sessionId: createSessionId("session_codex_phase6"),
			bindingSource: "launched",
			now: "2026-04-04T01:05:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_phase6",
			agentType: "claude",
			sessionId: createSessionId("session_claude_phase6"),
			bindingSource: "launched",
			now: "2026-04-04T01:05:00.000Z",
		});

		expect(() =>
			enqueueRelayWork({
				broker,
				collabId: "collab_phase6",
				originSessionId: createSessionId("session_claude_phase6"),
				target: "codex",
				instruction: "review this plan",
				artifactPaths: [],
				forceNewThread: false,
				now: "2026-04-04T01:05:01.000Z",
			}),
		).toThrow(/requires explicit artifacts/i);
	});

	it("routes tell and relay work through the currently bound session", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });

		broker.control.startCollab({
			collabId: "collab_bound_routing",
			workspaceRoot: "/tmp/workspace",
			displayName: "bound routing",
			now: "2026-04-05T10:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: "session_codex_bound",
			collabId: "collab_bound_routing",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T10:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: "session_claude_bound",
			collabId: "collab_bound_routing",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T10:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_bound_routing",
			agentType: "codex",
			sessionId: "session_codex_bound",
			bindingSource: "launched",
			now: "2026-04-05T10:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_bound_routing",
			agentType: "claude",
			sessionId: "session_claude_bound",
			bindingSource: "launched",
			now: "2026-04-05T10:00:00.000Z",
		});

		const relay = enqueueRelayWork({
			broker,
			collabId: "collab_bound_routing",
			originSessionId: "session_codex_bound",
			target: "claude",
			instruction: "implement this feature",
			artifactPaths: [],
			forceNewThread: false,
			now: "2026-04-05T10:00:01.000Z",
		});

		expect(relay.targetSessionId).toBe("session_claude_bound");
	});

	it("rejects stale sessions from polling work after rebind", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });

		broker.control.startCollab({
			collabId: "collab_stale_poll",
			workspaceRoot: "/tmp/workspace",
			displayName: "stale poll",
			now: "2026-04-05T11:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: "session_codex_stale",
			collabId: "collab_stale_poll",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T11:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_stale_poll",
			agentType: "codex",
			sessionId: "session_codex_stale",
			bindingSource: "launched",
			now: "2026-04-05T11:00:00.000Z",
		});

		// Register the stale session as a companion so it has a secret
		const ack = broker.control.registerCompanion({
			collabId: "collab_stale_poll",
			sessionId: "session_codex_stale",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T11:00:00.000Z",
		});

		// Issue a rebind claim — this puts the binding into pending_attach while keeping the old session authoritative
		const claim = broker.control.issueAttachClaim({
			collabId: "collab_stale_poll",
			agentType: "codex",
			mode: "rebind",
			now: "2026-04-05T11:01:00.000Z",
			expiresAt: "2026-04-05T11:06:00.000Z",
		});

		// Complete the rebind with a new session
		broker.control.completeAttachClaim({
			claimId: claim.claimId,
			secret: claim.secret,
			sessionId: "session_codex_new",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T11:02:00.000Z",
			bindingSource: "attached",
		});

		// The old session should now be rejected when polling
		expect(() =>
			broker.control.pollQueuedWorkItem({
				collabId: "collab_stale_poll",
				sessionId: "session_codex_stale",
				sessionSecret: ack.sessionSecret,
			}),
		).toThrow(/active binding/i);
	});

	it("cancels queued relay work before delivery with a failure reply", () => {
		const broker = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });

		broker.control.startCollab({
			collabId: "collab_cancel_queued",
			workspaceRoot: "/tmp/workspace",
			displayName: "cancel queued",
			now: "2026-04-06T03:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: "session_codex_cancel_queued",
			collabId: "collab_cancel_queued",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-06T03:00:00.000Z",
		});
		broker.control.registerSession({
			sessionId: "session_claude_cancel_queued",
			collabId: "collab_cancel_queued",
			agentType: "claude",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-06T03:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_cancel_queued",
			agentType: "codex",
			sessionId: "session_codex_cancel_queued",
			bindingSource: "launched",
			now: "2026-04-06T03:00:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: "collab_cancel_queued",
			agentType: "claude",
			sessionId: "session_claude_cancel_queued",
			bindingSource: "launched",
			now: "2026-04-06T03:00:00.000Z",
		});

		const relay = enqueueRelayWork({
			broker,
			collabId: "collab_cancel_queued",
			originSessionId: "session_codex_cancel_queued",
			target: "claude",
			instruction: "please answer later",
			artifactPaths: [],
			forceNewThread: false,
			now: "2026-04-06T03:00:01.000Z",
		});

		broker.control.requestWorkItemCancellation({
			workItemId: relay.workItem.workItemId,
			requestedAt: "2026-04-06T03:00:02.000Z",
		});

		expect(broker.control.getWorkItem(relay.workItem.workItemId)?.deliveryState).toBe("failed");
		expect(
			broker.control
				.listReplies(relay.thread.threadId)
				.find((reply) => reply.workItemId === relay.workItem.workItemId)?.content,
		).toBe("Relay work cancelled by user");
	});
});
