import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	insertBrokerDaemon,
	getBrokerDaemonByCollab,
	updateBrokerDaemonPid,
	getRecoveryState,
} from "../packages/broker/src/index.ts";
import { resolveCollab } from "../packages/cli/src/runtime/collab-resolver.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { runCollabRecover } from "../packages/cli/src/commands/collab/recover.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function insertSessionBinding(
	db: ReturnType<typeof openDatabase>,
	input: {
		collabId: string;
		agentType: "codex" | "claude";
		activeSessionId: string | null;
	},
): void {
	db.prepare(
		`INSERT INTO session_binding (
			collab_id, agent_type, binding_state, active_session_id, binding_source, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		input.collabId,
		input.agentType,
		input.activeSessionId ? "bound" : "unbound",
		input.activeSessionId,
		input.activeSessionId ? "launched" : null,
		"2026-05-15T00:00:00Z",
	);
}

function seed() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "recover-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES ('collab_c1', ?, 't', 'active', ?, 'none', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(ws, wsId);
	db.close();
	return { tmp, ws };
}

describe("runCollabRecover", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("clears orphan pid IS NULL row, spawns new daemon, completes readiness", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		db.close();
		await runCollabRecover({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			staleThresholdMs: 1_000,
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }) => {
				const d = openDatabase(getSharedSqlitePath());
				d.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(98765, "2026-05-15T00:01:01Z", collabId);
				d.close();
				return 98765;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		const d = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(d, "collab_c1")?.pid).toBe(98765);
		d.close();
	});

	it("recovers after kill -9 (row has pid set but the process is dead)", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "collab_c1",
			pid: 99999,
			pidStartTime: "OLDSTART",
			now: "2026-05-15T00:00:00Z",
		});
		db.close();
		await runCollabRecover({
			cwd: ws,
			now: () => new Date().toISOString(),
			isPortFreeOs: async () => true,
			isAlive: async () => ({ alive: false, startTime: null }),
			spawnBroker: ({ collabId }) => {
				const d = openDatabase(getSharedSqlitePath());
				d.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(77777, new Date().toISOString(), collabId);
				d.close();
				return 77777;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		});
		const d = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(d, "collab_c1")?.pid).toBe(77777);
		d.close();
	});

	it("rejects when a sibling recover has a fresh pid IS NULL reservation in flight", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: new Date(Date.now() - 1000).toISOString(),
			lastHeartbeatAt: new Date(Date.now() - 1000).toISOString(),
		});
		db.close();
		await expect(
			runCollabRecover({
				cwd: ws,
				now: () => new Date().toISOString(),
				staleThresholdMs: 90_000,
				isPortFreeOs: async () => true,
				spawnBroker: () => {
					throw new Error("spawn should not run when recovery is already in progress");
				},
				waitForReady: async () => true,
				signalProcess: () => {},
				isAlive: async () => ({ alive: false, startTime: null }),
			}),
		).rejects.toThrow(/recovery already in progress/);
	});

	it("refuses when a live daemon is already running", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: new Date().toISOString(),
		});
		updateBrokerDaemonPid(db, {
			collabId: "collab_c1",
			pid: process.pid,
			pidStartTime: null,
			now: new Date().toISOString(),
		});
		db.close();
		await expect(
			runCollabRecover({
				cwd: ws,
				now: () => "2026-05-15T00:01:00Z",
				isPortFreeOs: async () => true,
				spawnBroker: () => 1,
				waitForReady: async () => true,
				signalProcess: () => {},
				isAlive: async () => ({ alive: true, startTime: null }),
			}),
		).rejects.toThrow(/already running/i);
	});

	it("reclaims an orphan pid IS NULL row older than the stale threshold", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		db.close();
		await runCollabRecover({
			cwd: ws,
			now: () => new Date().toISOString(),
			staleThresholdMs: 1_000,
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }) => {
				const d = openDatabase(getSharedSqlitePath());
				d.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(55555, new Date().toISOString(), collabId);
				d.close();
				return 55555;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		const d = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(d, "collab_c1")?.pid).toBe(55555);
		d.close();
	});

	it("re-arms bindings and writes recovery_state='recovered' when the collab has remembered bindings", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		insertSessionBinding(db, {
			collabId: "collab_c1",
			agentType: "codex",
			activeSessionId: "session_codex_1",
		});
		db.close();
		await runCollabRecover({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			staleThresholdMs: 1_000,
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }) => {
				const d = openDatabase(getSharedSqlitePath());
				d.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(98765, "2026-05-15T00:01:01Z", collabId);
				d.close();
				return 98765;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		const d = openDatabase(getSharedSqlitePath());
		const recovery = getRecoveryState(d, "collab_c1");
		expect(recovery).toEqual({
			collabId: "collab_c1",
			state: "recovered",
			idleAfterRecovery: true,
			recoveredAt: "2026-05-15T00:01:00Z",
		});
		const resolved = resolveCollab({ db: d, cwd: ws, requireActive: true });
		expect(resolved.recovery.state).toBe("recovered");
		d.close();
	});

	it("writes recovery_state='normal' when the collab has no remembered bindings", async () => {
		const { ws } = seed();
		const db = openDatabase(getSharedSqlitePath());
		insertBrokerDaemon(db, {
			collabId: "collab_c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		db.close();
		await runCollabRecover({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			staleThresholdMs: 1_000,
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }) => {
				const d = openDatabase(getSharedSqlitePath());
				d.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(98765, "2026-05-15T00:01:01Z", collabId);
				d.close();
				return 98765;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		const d = openDatabase(getSharedSqlitePath());
		const recovery = getRecoveryState(d, "collab_c1");
		expect(recovery).toEqual({
			collabId: "collab_c1",
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
		d.close();
	});
});
