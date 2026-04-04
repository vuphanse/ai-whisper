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
			originSessionId: "session_codex_phase6",
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

		expect(() =>
			enqueueRelayWork({
				broker,
				collabId: "collab_phase6",
				originSessionId: "session_claude_phase6",
				target: "codex",
				instruction: "review this plan",
				artifactPaths: [],
				forceNewThread: false,
				now: "2026-04-04T01:05:01.000Z",
			}),
		).toThrow(/requires explicit artifacts/i);
	});
});
