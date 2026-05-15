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
	getBrokerDaemonByCollab,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function setupActiveCollab(pid: number | null) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "stop-"));
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
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
	});
	if (pid !== null) {
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid,
			pidStartTime: null,
			now: "2026-05-15T00:00:00Z",
		});
	}
	db.close();
	return { tmp, ws };
}

describe("runCollabStop", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("deletes broker_daemon row, marks collab stopped, and signals the live daemon", async () => {
		const { ws } = setupActiveCollab(12345);
		const signals: Array<{ pid: number; sig: string }> = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
		});
		const db = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
		const row = db
			.prepare("SELECT status, stopped_at FROM collab WHERE collab_id = 'c1'")
			.get() as { status: string; stopped_at: string };
		expect(row.status).toBe("stopped");
		expect(row.stopped_at).toBe("2026-05-15T00:01:00Z");
		db.close();
		expect(signals).toEqual([{ pid: 12345, sig: "SIGTERM" }]);
	});

	it("orphan pid IS NULL row is removed without signaling", async () => {
		const { ws } = setupActiveCollab(null);
		const signals: Array<{ pid: number; sig: string }> = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
		});
		const db = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
		db.close();
		expect(signals).toEqual([]);
	});
});
