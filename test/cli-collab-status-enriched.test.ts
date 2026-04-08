import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

const healthyBroker = vi.fn(() => Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }));

describe("cli collab status enriched", () => {
	it("includes activeThread when a thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-enriched-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		await runCollabTell({
			workspaceRoot,
			target: "codex",
			instruction: "review this plan",
			explicitAction: "review_plan",
			artifactPaths: [planPath],
			threadTitle: "Review plan",
			providerOverride: createMockProvider(),
			now: "2026-04-03T00:00:01.000Z",
			assessBroker: healthyBroker,
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toMatchObject({
				title: "Review plan",
			});
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status).not.toHaveProperty("codexSessionId");
			expect(status).not.toHaveProperty("claudeSessionId");
			expect(status.roles.codex).toMatchObject({ bindingState: "bound", healthState: "healthy" });
			expect(status.roles.claude).toMatchObject({ bindingState: "bound", healthState: "healthy" });
		}
	});

	it("returns null activeThread and broker health when no thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-no-thread-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toBeNull();
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status).not.toHaveProperty("codexSessionId");
			expect(status).not.toHaveProperty("claudeSessionId");
			expect(status.roles.codex).toMatchObject({ bindingState: "bound", healthState: "healthy" });
			expect(status.roles.claude).toMatchObject({ bindingState: "bound", healthState: "healthy" });
		}
	});

	it("shows recovered and degraded state in status output when collab was recovered", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-recovered-"),
		);
		const runtimeDir = join(workspaceRoot, ".ai-whisper", "runtime");
		mkdirSync(runtimeDir, { recursive: true });
		const sqlitePath = join(runtimeDir, "broker.sqlite");
		const collabId = "collab_recovered_status";
		const now = "2026-04-05T19:00:00.000Z";

		// Set up minimal SQLite state
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4430 });
		broker.control.startCollab({
			collabId,
			workspaceRoot,
			displayName: "recovered status test",
			now,
		});
		await broker.stop();

		// Write state file with recovery.state === "recovered"
		const statePath = getStateFilePath(workspaceRoot);
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4430,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "recovered",
				idleAfterRecovery: true,
				recoveredAt: now,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status.recovery?.state).toBe("recovered");
			expect(status.idleAfterRecovery).toBe(true);
		}
	});

	it("returns last-known bindings on broker-down path instead of hardcoded unbound", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-broker-down-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		// Verify broker-down path reads last-known bindings from SQLite
		const downBroker = vi.fn(() => Promise.resolve({ pidAlive: false as const, httpReachable: false as const, ok: false as const }));
		const status = await runCollabStatus({ workspaceRoot, assessBroker: downBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			// runCollabStart sets up bound bindings; broker-down path should read them
			expect(status.roles.codex.bindingState).toBe("bound");
			expect(status.roles.claude.bindingState).toBe("bound");
			expect(status.brokerHealth).toEqual({ ok: false });
			expect(status.recovery.state).toBe("recovery_required");
		}
	});

	it("surfaces last-known session healthState on broker-down path", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-broker-down-health-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const downBroker = vi.fn(() => Promise.resolve({ pidAlive: false as const, httpReachable: false as const, ok: false as const }));
		const status = await runCollabStatus({ workspaceRoot, assessBroker: downBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			// Sessions were registered with healthState: "healthy" — that value must be
			// surfaced on the offline path, not fabricated as null.
			expect(status.roles.codex).toHaveProperty("healthState", "healthy");
			expect(status.roles.claude).toHaveProperty("healthState", "healthy");
		}
	});

	it("includes per-role healthState on healthy-broker path", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-health-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			// healthState should be present on bound roles
			expect(status.roles.codex).toMatchObject({ bindingState: "bound", healthState: "healthy" });
			expect(status.roles.claude).toMatchObject({ bindingState: "bound", healthState: "healthy" });
		}
	});
});

describe("turn-owned relay status", () => {
	it("includes turnOwner, waitingAgent, and handoffState in the status payload", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-status-turn-"));
		const runtimeDir = join(workspaceRoot, ".ai-whisper", "runtime");
		mkdirSync(runtimeDir, { recursive: true });
		const sqlitePath = join(runtimeDir, "broker.sqlite");
		const collabId = "collab_turn_status";
		const now = "2026-04-08T00:00:00.000Z";

		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4323 });
		broker.control.startCollab({ collabId, workspaceRoot, displayName: "turn status test", now });
		await broker.stop();

		writeCliCollabState(getStateFilePath(workspaceRoot), {
			version: 5,
			collabId,
			workspaceRoot,
			broker: { sqlitePath, host: "127.0.0.1", port: 4323, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status).toHaveProperty("turnOwner");
			expect(status).toHaveProperty("waitingAgent");
			expect(status).toHaveProperty("handoffState");
		}
	});
});

describe("phase 7c1 status output", () => {
	it("includes per-role healthState on the status payload for bound roles", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-status-health-"));
		const sqlitePath = join(workspaceRoot, "broker.sqlite");
		const now = "2026-04-06T11:00:00.000Z";
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4452 });

		broker.control.startCollab({
			collabId: "collab_status_health",
			workspaceRoot,
			displayName: "status health",
			now,
		});
		for (const agentType of ["codex", "claude"] as const) {
			broker.control.registerSession({
				sessionId: `session_${agentType}`,
				collabId: "collab_status_health",
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
			broker.control.setSessionBinding({
				collabId: "collab_status_health",
				agentType,
				sessionId: `session_${agentType}`,
				bindingSource: "attached",
				now,
			});
		}
		await broker.stop();

		writeCliCollabState(join(workspaceRoot, ".ai-whisper", "runtime", "current-collab.json"), {
			version: 5,
			collabId: "collab_status_health",
			workspaceRoot,
			broker: { sqlitePath, host: "127.0.0.1", port: 4452, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		const status = await runCollabStatus({
			workspaceRoot,
			assessBroker: () => Promise.resolve({ pidAlive: true, httpReachable: true, ok: true }),
		});

		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.roles.codex).toMatchObject({
				bindingState: "bound",
				healthState: "healthy",
			});
			expect(status.roles.claude).toMatchObject({
				bindingState: "bound",
				healthState: "healthy",
			});
		}
	});
});
