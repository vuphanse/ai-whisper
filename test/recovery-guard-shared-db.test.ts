import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	insertBrokerDaemon,
	updateBrokerDaemonPid,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { evaluateRecoveryNeed } from "../packages/cli/src/runtime/recovery-guard.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function setup(pid: number | null) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "rg-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES ('c1', ?, 't', 'active', ?, 'none', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(ws, wsId);
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: new Date().toISOString(),
	});
	if (pid !== null) {
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid,
			pidStartTime: null,
			now: new Date().toISOString(),
		});
	}
	db.close();
	return { ws };
}

describe("evaluateRecoveryNeed", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("returns healthy when pid is set and process is alive", async () => {
		const { ws } = setup(process.pid);
		const r = await evaluateRecoveryNeed({
			cwd: ws,
			isAlive: async () => ({ alive: true, startTime: null }),
		});
		expect(r.healthy).toBe(true);
	});

	it("requests recovery when pid IS NULL (orphan reservation)", async () => {
		const { ws } = setup(null);
		const r = await evaluateRecoveryNeed({
			cwd: ws,
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		expect(r.healthy).toBe(false);
	});

	it("requests recovery when pid is set but process is dead", async () => {
		const { ws } = setup(99999);
		const r = await evaluateRecoveryNeed({
			cwd: ws,
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		expect(r.healthy).toBe(false);
	});
});
