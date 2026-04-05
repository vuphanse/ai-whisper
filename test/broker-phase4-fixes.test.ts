import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";
import { createCompanionRuntime } from "../packages/companion-core/src/create-companion-runtime.ts";
import { listSessionsForCollab } from "../packages/broker/src/storage/repositories/session-repository.ts";
import { getWorkItem } from "../packages/broker/src/storage/repositories/work-item-repository.ts";
import type {
	CompanionProvider,
	ProviderReply,
} from "../packages/shared/src/index.ts";

function makeRuntime() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase4-fixes-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "broker.sqlite"),
		host: "127.0.0.1",
		port: 4311,
	});
}

function setupCollab(runtime: ReturnType<typeof makeRuntime>) {
	const collab = runtime.control.startCollab({
		collabId: "collab_fix1",
		workspaceRoot: "/tmp/test",
		displayName: "test",
		now: "2026-04-03T00:00:00.000Z",
	});

	runtime.control.registerSession({
		sessionId: "session_claude_1",
		collabId: collab.collabId,
		agentType: "claude",
		capabilities: { supportsDirectPackets: true },
		now: "2026-04-03T00:00:01.000Z",
	});

	runtime.control.registerSession({
		sessionId: "session_codex_1",
		collabId: collab.collabId,
		agentType: "codex",
		capabilities: { supportsDirectPackets: true },
		now: "2026-04-03T00:00:02.000Z",
	});

	runtime.control.setSessionBinding({
		collabId: collab.collabId,
		agentType: "codex",
		sessionId: "session_codex_1",
		bindingSource: "launched",
		now: "2026-04-03T00:00:02.000Z",
	});

	const thread = runtime.control.createThread({
		threadId: "thread_fix1",
		collabId: collab.collabId,
		title: "Test thread",
		createdBySessionId: "session_claude_1",
		now: "2026-04-03T00:00:03.000Z",
	});

	const workItem = runtime.control.enqueueWorkItem({
		workItemId: "work_fix1",
		threadId: thread.threadId,
		collabId: collab.collabId,
		senderSessionId: "session_claude_1",
		targetSessionId: "session_codex_1",
		requestedAction: "review_plan",
		instruction: "Review this.",
		contextPacket: {
			kind: "full",
			goal: "Test",
			currentState: "Testing",
			decisionsMade: [],
			assumptions: [],
			relevantArtifacts: [],
			openQuestions: [],
			successCriteria: [],
		},
		artifactManifestIds: [],
		now: "2026-04-03T00:00:04.000Z",
	});

	return { collab, thread, workItem };
}

function createExplodingProvider(): CompanionProvider {
	return {
		getIdentity() {
			return {
				providerId: "exploding-provider",
				toolFamily: "mock-agent",
				providerVersion: "1.0.0",
			};
		},
		getCapabilities() {
			return {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: false,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			};
		},
		getHealthState() {
			return "healthy";
		},
		handleWork(): Promise<ProviderReply> {
			return Promise.reject(new Error("provider exploded"));
		},
	};
}

describe("phase 4 code review fixes", () => {
	let runtime: ReturnType<typeof makeRuntime>;

	beforeEach(() => {
		runtime = makeRuntime();
	});

	it("finding 1: registerCompanion rejects a session that was never registered", () => {
		const { collab } = setupCollab(runtime);

		expect(() =>
			runtime.control.registerCompanion({
				collabId: collab.collabId,
				sessionId: "session_missing_1",
				provider: {
					providerId: "mock-provider",
					toolFamily: "mock-agent",
					providerVersion: "1.0.0",
				},
				capabilities: {
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: false,
					supportsLocalBuffering: false,
					supportsLaunchHooks: false,
					extensions: {},
				},
				now: "2026-04-03T00:00:05.000Z",
			}),
		).toThrow();
	});

	it("finding 2: provider error marks work item as failed instead of leaving it stuck", async () => {
		const { collab, workItem } = setupCollab(runtime);

		const companion = createCompanionRuntime({
			broker: runtime,
			collabId: collab.collabId,
			sessionId: "session_codex_1",
			provider: createExplodingProvider(),
		});

		companion.register("2026-04-03T00:00:05.000Z");
		const result = await companion.processNext("2026-04-03T00:00:06.000Z");

		// Should return a failure reply, not throw
		expect(result?.kind).toBe("failure");

		const updated = getWorkItem(runtime.db, workItem.workItemId);
		expect(updated?.deliveryState).toBe("failed");
		expect(updated?.completedAt).not.toBe("2026-04-03T00:00:06.000Z");
		expect(Date.parse(updated?.completedAt ?? "")).toBeGreaterThan(
			Date.parse("2026-04-03T00:00:06.000Z"),
		);
	});

	it("finding 3: companion heartbeat updates the main session health state", () => {
		const { collab } = setupCollab(runtime);

		const ack = runtime.control.registerCompanion({
			collabId: collab.collabId,
			sessionId: "session_codex_1",
			provider: {
				providerId: "mock-provider",
				toolFamily: "mock-agent",
				providerVersion: "1.0.0",
			},
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: false,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now: "2026-04-03T00:00:05.000Z",
		});

		runtime.control.recordCompanionHeartbeat({
			collabId: collab.collabId,
			sessionId: "session_codex_1",
			sessionSecret: ack.sessionSecret,
			healthState: "degraded",
			now: "2026-04-03T00:00:10.000Z",
		});

		const sessions = listSessionsForCollab(runtime.db, collab.collabId);
		const codexSession = sessions.find(
			(s) => s.sessionId === "session_codex_1",
		);
		expect(codexSession?.healthState).toBe("degraded");
		expect(codexSession?.lastSeenAt).toBe("2026-04-03T00:00:10.000Z");
	});
});
