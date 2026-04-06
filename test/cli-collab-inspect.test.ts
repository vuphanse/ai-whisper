import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runCollabInspect } from "../packages/cli/src/commands/collab/inspect.ts";
import { buildInspectSnapshot, formatInspectSnapshot, truncatePreview } from "../packages/cli/src/runtime/operator-inspect.ts";
import type { CliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";

describe("collab inspect snapshot", () => {
	it("renders the active thread snapshot", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const now = "2026-04-06T10:00:00.000Z";
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4450 });

		broker.control.startCollab({
			collabId: "collab_inspect",
			workspaceRoot,
			displayName: "inspect",
			now,
		});
		broker.control.registerSession({
			sessionId: "session_codex",
			collabId: "collab_inspect",
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
		broker.control.setSessionBinding({
			collabId: "collab_inspect",
			agentType: "codex",
			sessionId: "session_codex",
			bindingSource: "attached",
			now,
		});
		broker.control.createThread({
			threadId: "thread_active",
			collabId: "collab_inspect",
			title: "Review plan",
			createdBySessionId: "session_codex",
			now,
		});
		await broker.stop();

		writeCliCollabState(join(workspaceRoot, ".ai-whisper", "runtime", "current-collab.json"), {
			version: 5,
			collabId: "collab_inspect",
			workspaceRoot,
			broker: { sqlitePath, host: "127.0.0.1", port: 4450, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		const output = await runCollabInspect({
			workspaceRoot,
			now,
			watch: false,
			assessBroker: () => Promise.resolve({ pidAlive: true, httpReachable: true, ok: true }),
		});
		expect(output).toContain("Active Thread: Review plan");
		expect(output).toContain("Roles:");
	});
});

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

describe("collab inspect watch mode", () => {
	it("redraws periodically and stops cleanly on interrupt", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-watch-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const now = "2026-04-06T10:30:00.000Z";
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4451 });

		broker.control.startCollab({
			collabId: "collab_inspect_watch",
			workspaceRoot,
			displayName: "inspect watch",
			now,
		});
		await broker.stop();

		writeCliCollabState(join(workspaceRoot, ".ai-whisper", "runtime", "current-collab.json"), {
			version: 5,
			collabId: "collab_inspect_watch",
			workspaceRoot,
			broker: { sqlitePath, host: "127.0.0.1", port: 4451, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		const write = vi.fn();
		const sleep = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockImplementation(() => Promise.reject(new Error("stop-watch")));

		await expect(
			runCollabInspect({
				workspaceRoot,
				now,
				watch: true,
				write,
				sleep,
				assessBroker: () => Promise.resolve({ pidAlive: true, httpReachable: true, ok: true }),
			}),
		).rejects.toThrow("stop-watch");

		expect(write).toHaveBeenCalled();
		expect(write.mock.calls.some(([chunk]) => String(chunk).includes("Live Inspect"))).toBe(true);
	});
});

describe("inspect broker-down recovery latch", () => {
	it("latches recovery_required and throws when broker is down during normal state", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-latch-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const now = "2026-04-06T10:00:00.000Z";
		const statePath = join(workspaceRoot, ".ai-whisper", "runtime", "current-collab.json");

		writeCliCollabState(statePath, {
			version: 5,
			collabId: "collab_inspect_latch",
			workspaceRoot,
			broker: { sqlitePath, host: "127.0.0.1", port: 4460, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		await expect(
			runCollabInspect({
				workspaceRoot,
				now,
				watch: false,
				assessBroker: () => Promise.resolve({ pidAlive: false, httpReachable: false, ok: false }),
			}),
		).rejects.toThrow("Broker is unavailable");

		const updated = readCliCollabState(statePath);
		expect(updated?.recovery.state).toBe("recovery_required");
	});
});

describe("inspect flagged items outside display window", () => {
	it("includes flagged work items that fall outside the last-5 display window", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4461 });
		const collabId = "collab_flagged_window";
		const now = "2026-04-06T09:00:00.000Z";

		runtime.control.startCollab({ collabId, workspaceRoot: "/tmp", displayName: "flagged", now });
		for (const agentType of ["codex", "claude"] as const) {
			runtime.control.registerSession({
				sessionId: `session_${agentType}`,
				collabId,
				agentType,
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
		}
		runtime.control.createThread({
			threadId: "thread_flagged",
			collabId,
			title: "Flag test",
			createdBySessionId: "session_codex",
			now,
		});

		// Enqueue 6 work items; work_1 will be marked failed but falls outside the last-5 display window
		for (let i = 1; i <= 6; i++) {
			runtime.control.enqueueWorkItem({
				workItemId: `work_${i}`,
				threadId: "thread_flagged",
				collabId,
				senderSessionId: "session_codex",
				targetSessionId: "session_claude",
				requestedAction: "review_plan",
				instruction: `instruction ${i}`,
				contextPacket: {
					kind: "full",
					goal: "g",
					currentState: "s",
					decisionsMade: [],
					assumptions: [],
					relevantArtifacts: [],
					openQuestions: [],
					successCriteria: [],
				},
				now: `2026-04-06T09:0${i}:00.000Z`,
			});
		}

		runtime.control.postReply({
			replyId: "reply_fail",
			threadId: "thread_flagged",
			collabId,
			workItemId: "work_1",
			sourceSessionId: "session_claude",
			kind: "failure",
			content: "failed",
			transitionIntent: null,
			artifactManifestIds: [],
			now: "2026-04-06T09:01:30.000Z",
		});

		const state: CliCollabState = {
			version: 5,
			collabId,
			workspaceRoot: "/tmp",
			broker: {
				sqlitePath: ":memory:",
				host: "127.0.0.1",
				port: 4461,
				pid: 1,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		};

		const snapshot = buildInspectSnapshot({
			broker: runtime,
			state,
			now,
		});

		// Display window (last 5) excludes work_1
		expect(snapshot.workItems.map((w) => w.workItemId)).toEqual([
			"work_6",
			"work_5",
			"work_4",
			"work_3",
			"work_2",
		]);
		// But flaggedItems must still surface work_1
		expect(snapshot.flaggedItems).toHaveLength(1);
		const [flagged] = snapshot.flaggedItems;
		expect(flagged?.workItemId).toBe("work_1");
		expect(flagged?.deliveryState).toBe("failed");
	});
});

describe("adopted operator visibility", () => {
	it("renders adopted binding source and tty path in inspect output", () => {
		const output = formatInspectSnapshot({
			collabId: "collab_adopted",
			recoveryState: "normal",
			brokerHealth: "ok",
			roles: [
				{
					agentType: "codex",
					bindingState: "bound",
					healthState: "healthy",
					bindingSource: "adopted",
					targetTtyPath: "/dev/ttys012",
				},
				{
					agentType: "claude",
					bindingState: "unbound",
					healthState: null,
					bindingSource: null,
					targetTtyPath: null,
				},
			],
			activeThread: null,
			workItems: [],
			replies: [],
			flaggedItems: [],
			watch: false,
			refreshedAt: "2026-04-06T17:00:00.000Z",
		});

		expect(output).toContain("codex: bound (healthy) [adopted]");
		expect(output).toContain("/dev/ttys012");
	});

	it("surfaces adopted binding source in buildInspectSnapshot", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4470 });
		const now = "2026-04-06T17:00:00.000Z";

		runtime.control.startCollab({ collabId: "collab_adopt_snap", workspaceRoot: "/tmp", displayName: "adopt snap", now });
		runtime.control.registerSession({
			sessionId: "session_codex_adopt",
			collabId: "collab_adopt_snap",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now,
		});
		runtime.control.setSessionBinding({
			collabId: "collab_adopt_snap",
			agentType: "codex",
			sessionId: "session_codex_adopt",
			bindingSource: "adopted",
			targetTtyPath: "/dev/ttys012",
			now,
		});

		const snapshot = buildInspectSnapshot({
			broker: runtime,
			state: {
				version: 5,
				collabId: "collab_adopt_snap",
				workspaceRoot: "/tmp",
				broker: { sqlitePath: ":memory:", host: "127.0.0.1", port: 4470, pid: 1 },
				launch: { mode: "none" },
				ownedSessions: {},
				startedAt: now,
				recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
				adoptedSessions: {},
				mountedSessions: {},
			},
			now,
		});

		const codexRole = snapshot.roles.find((r) => r.agentType === "codex");
		expect(codexRole?.bindingSource).toBe("adopted");
		expect(codexRole?.targetTtyPath).toBe("/dev/ttys012");
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
