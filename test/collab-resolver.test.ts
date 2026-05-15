import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	upsertRecoveryState,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import {
	resolveCollab,
	CollabResolverError,
} from "../packages/cli/src/runtime/collab-resolver.ts";

function setup() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "resolver-"));
	const cwd = path.join(tmp, "ws");
	mkdirSync(cwd);
	const db = openDatabase(path.join(tmp, "broker.sqlite"));
	applyMigrations(db);
	const wsId = workspaceIdFromPath(cwd);
	return { tmp, cwd, db, wsId };
}

function seedActiveCollab(
	db: ReturnType<typeof openDatabase>,
	wsId: string,
	cwd: string,
	collabId: string,
) {
	upsertWorkspace(db, { id: wsId, workspaceRoot: cwd, now: "2026-05-15T00:00:00Z" });
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, 'tmux', 'ai-whisper-test', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(collabId, cwd, "test", wsId);
	upsertRecoveryState(db, {
		collabId,
		state: "normal",
		idleAfterRecovery: false,
		recoveredAt: null,
	});
}

describe("resolveCollab", () => {
	it("throws NoCollabFoundForCwd when nothing is registered", () => {
		const { db, cwd } = setup();
		expect(() => resolveCollab({ db, cwd })).toThrow(CollabResolverError);
		try {
			resolveCollab({ db, cwd });
		} catch (err) {
			expect((err as CollabResolverError).kind).toBe("NoCollabFoundForCwd");
		}
	});

	it("returns the active collab and daemon when present", () => {
		const { db, cwd, wsId } = setup();
		seedActiveCollab(db, wsId, cwd, "c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 9999,
			pidStartTime: null,
			now: "2026-05-15T00:00:00Z",
		});
		const resolved = resolveCollab({ db, cwd });
		expect(resolved.collabId).toBe("c1");
		expect(resolved.daemon?.port).toBe(4500);
		expect(resolved.daemon?.pid).toBe(9999);
	});

	it("daemon is null when broker_daemon row exists but pid IS NULL", () => {
		const { db, cwd, wsId } = setup();
		seedActiveCollab(db, wsId, cwd, "c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		const resolved = resolveCollab({ db, cwd });
		expect(resolved.daemon).toBeNull();
	});

	it("throws NoLiveDaemonForCollab when requireDaemon and daemon missing", () => {
		const { db, cwd, wsId } = setup();
		seedActiveCollab(db, wsId, cwd, "c1");
		expect(() => resolveCollab({ db, cwd, requireDaemon: true })).toThrow(CollabResolverError);
		try {
			resolveCollab({ db, cwd, requireDaemon: true });
		} catch (err) {
			expect((err as CollabResolverError).kind).toBe("NoLiveDaemonForCollab");
		}
	});

	it("--collab override bypasses cwd lookup", () => {
		const { db, cwd, wsId } = setup();
		seedActiveCollab(db, wsId, cwd, "c1");
		const resolved = resolveCollab({ db, cwd: "/some/unrelated/path", collabIdOverride: "c1" });
		expect(resolved.collabId).toBe("c1");
	});

	it("CollabAlreadyStopped when collab status is stopped and requireActive set", () => {
		const { db, cwd, wsId } = setup();
		seedActiveCollab(db, wsId, cwd, "c1");
		db.prepare("UPDATE collab SET status='stopped', stopped_at='now' WHERE collab_id='c1'").run();
		expect(() => resolveCollab({ db, cwd, requireActive: true })).toThrow(CollabResolverError);
		try {
			resolveCollab({ db, cwd, requireActive: true });
		} catch (err) {
			expect((err as CollabResolverError).kind).toBe("CollabAlreadyStopped");
		}
	});
});
