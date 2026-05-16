import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessBrokerDaemon } from "../packages/cli/src/runtime/broker-daemon.ts";
import { runCollabReconnect } from "../packages/cli/src/commands/collab/reconnect.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import {
	createBrokerRuntime,
	insertBrokerDaemon,
	upsertRecoveryState,
	upsertWorkspace,
} from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

describe("cli recovery state", () => {
	it("marks the broker unavailable when pid and health probe both fail", async () => {
		const result = await assessBrokerDaemon({
			host: "127.0.0.1",
			port: 4311,
			pid: 99999,
			fetchImpl: vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED"))) as never,
			killImpl: vi.fn(() => {
				throw new Error("no such process");
			}) as never,
		});

		expect(result).toEqual({
			pidAlive: false,
			httpReachable: false,
			ok: false,
		});
	});
});

interface ReconnectFixture {
	tmpRoot: string;
	dir: string;
	collabId: string;
	port: number;
	now: string;
}

async function buildReconnectFixture(opts: {
	port: number;
	recoveryState: "normal" | "recovery_required" | "recovered";
	registerBinding?: boolean;
}): Promise<ReconnectFixture> {
	const tmpRoot = mkdtempSync(join(tmpdir(), "ai-whisper-reconnect-"));
	process.env.AI_WHISPER_STATE_ROOT = tmpRoot;
	const dir = join(tmpRoot, "ws");
	mkdirSync(dir);
	const collabId = `collab_reconnect_${opts.port}`;
	const now = "2026-04-05T17:00:00.000Z";

	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(dir);
	upsertWorkspace(db, { id: wsId, workspaceRoot: dir, now });
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'reconnect test', 'active', ?, 'none', null, ?, ?)",
	).run(collabId, dir, wsId, now, now);
	insertBrokerDaemon(db, {
		collabId,
		host: "127.0.0.1",
		port: opts.port,
		startedAt: now,
		lastHeartbeatAt: now,
	});
	// Fill in pid so requireDaemon: true is satisfied.
	db.prepare(
		"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
	).run(99123, now, collabId);
	upsertRecoveryState(db, {
		collabId,
		state: opts.recoveryState,
		idleAfterRecovery: opts.recoveryState === "recovered",
		recoveredAt: opts.recoveryState === "recovered" ? now : null,
	});
	db.close();

	if (opts.registerBinding) {
		// Use a per-workspace broker runtime to register a session binding
		// in the shared DB.
		const broker = createBrokerRuntime({
			sqlitePath: getSharedSqlitePath(),
			host: "127.0.0.1",
			port: opts.port,
		});
		broker.control.registerSession({
			sessionId: `session_codex_${opts.port}`,
			collabId,
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
			collabId,
			agentType: "codex",
			sessionId: `session_codex_${opts.port}`,
			bindingSource: "mounted",
			now,
		});
		broker.control.prepareCollabRecovery({ collabId, now });
		await broker.stop();
	}

	return { tmpRoot, dir, collabId, port: opts.port, now };
}

describe("reconnect command", () => {
	it("throws when recovery state is not 'recovered'", async () => {
		const { dir, now } = await buildReconnectFixture({
			port: 4411,
			recoveryState: "normal",
		});

		try {
			await expect(
				runCollabReconnect({ workspaceRoot: dir, target: "codex", now }),
			).rejects.toThrow(/recovered/i);
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});

	it("throws when the target has no remembered binding", async () => {
		const { dir, now } = await buildReconnectFixture({
			port: 4412,
			recoveryState: "recovered",
			registerBinding: true,
		});

		try {
			// claude has no binding, so reconnect for claude should throw
			await expect(
				runCollabReconnect({ workspaceRoot: dir, target: "claude", now }),
			).rejects.toThrow(/no remembered binding/i);
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});

describe("recovery guards", () => {
	async function buildTellNoDaemonFixture(opts: { recoveryState: "recovery_required" | "recovered" }) {
		const tmp = mkdtempSync(join(tmpdir(), "ai-whisper-guard-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = join(tmp, "ws");
		mkdirSync(ws);
		const collabId = "collab_guard_test";
		const now = "2026-04-05T18:00:00.000Z";

		const db = openDatabase(getSharedSqlitePath());
		applyMigrations(db);
		const wsId = workspaceIdFromPath(ws);
		upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'guard test', 'active', ?, 'none', null, ?, ?)",
		).run(collabId, ws, wsId, now, now);
		upsertRecoveryState(db, {
			collabId,
			state: opts.recoveryState,
			idleAfterRecovery: opts.recoveryState === "recovered",
			recoveredAt: opts.recoveryState === "recovered" ? now : null,
		});
		// No broker_daemon row → resolveCollab(requireDaemon=true) throws NoLiveDaemonForCollab.
		db.close();

		return { ws, now };
	}

	it("throws when tell is attempted against a collab whose daemon is not live (recovery_required)", async () => {
		const { ws, now } = await buildTellNoDaemonFixture({ recoveryState: "recovery_required" });

		try {
			await expect(
				runCollabTell({
					cwd: ws,
					target: "codex",
					instruction: "review this",
					artifactPaths: [],
					now,
				}),
			).rejects.toThrow(/no live daemon/i);
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});

	it("throws when tell is attempted against a recovered collab whose daemon is not live", async () => {
		const { ws, now } = await buildTellNoDaemonFixture({ recoveryState: "recovered" });

		try {
			await expect(
				runCollabTell({
					cwd: ws,
					target: "codex",
					instruction: "review this",
					artifactPaths: [],
					now,
				}),
			).rejects.toThrow(/no live daemon/i);
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});

describe("broker latch", () => {
	it("tell fails fast with NoLiveDaemonForCollab when broker_daemon row has pid IS NULL", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "ai-whisper-latch-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		try {
			const ws = join(tmp, "ws");
			mkdirSync(ws);
			const collabId = "collab_latch_test";
			const now = "2026-04-05T19:00:00.000Z";

			const db = openDatabase(getSharedSqlitePath());
			applyMigrations(db);
			const wsId = workspaceIdFromPath(ws);
			upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now });
			db.prepare(
				"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'latch test', 'active', ?, 'none', null, ?, ?)",
			).run(collabId, ws, wsId, now, now);
			db.prepare(
				"INSERT INTO broker_daemon (collab_id, host, port, started_at, last_heartbeat_at) VALUES (?, '127.0.0.1', 4430, ?, ?)",
			).run(collabId, now, now);
			db.close();

			await expect(
				runCollabTell({
					cwd: ws,
					target: "codex",
					instruction: "review this",
					artifactPaths: [],
					now,
				}),
			).rejects.toThrow(/no live daemon/i);
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});

describe("status command recovery awareness", () => {
	it("shows recovery_required state in status when collab is marked recovery_required", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "ai-whisper-status-recovery-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		try {
			const ws = join(tmp, "ws");
			mkdirSync(ws);
			const collabId = "collab_status_recovery";
			const now = "2026-04-05T16:05:00.000Z";

			const sharedDb = openDatabase(getSharedSqlitePath());
			applyMigrations(sharedDb);
			const wsId = workspaceIdFromPath(ws);
			upsertWorkspace(sharedDb, { id: wsId, workspaceRoot: ws, now });
			sharedDb
				.prepare(
					"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES (?, ?, 'status recovery test', 'active', ?, 'none', ?, ?)",
				)
				.run(collabId, ws, wsId, now, now);
			upsertRecoveryState(sharedDb, {
				collabId,
				state: "recovery_required",
				idleAfterRecovery: false,
				recoveredAt: null,
			});
			sharedDb.close();

			const output = await runCollabStatus({ cwd: ws });
			expect(output).toContain(collabId);
			expect(output).toContain("recovery: recovery_required");
			expect(output).toContain("daemon: not running");
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});

describe("mounted reconnect", () => {
	it("defaults to mounted mode when the remembered binding source is mounted", async () => {
		const { dir, now } = await buildReconnectFixture({
			port: 4413,
			recoveryState: "recovered",
			registerBinding: true,
		});

		try {
			const startMountedSession = vi.fn(() => Promise.resolve());
			const result = await runCollabReconnect({
				workspaceRoot: dir,
				target: "codex",
				now,
				resolveCurrentTty: () => "/dev/ttys031",
				startMountedSession,
			});

			expect(result.mode).toBe("mounted");
			expect(startMountedSession).toHaveBeenCalledWith(expect.objectContaining({ ttyPath: "/dev/ttys031" }));
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});
