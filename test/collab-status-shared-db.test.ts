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
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("runCollabStatus via shared DB", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("renders 'active' with port and pid for a live collab", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "status-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const db = openDatabase(getSharedSqlitePath());
		applyMigrations(db);
		const wsId = workspaceIdFromPath(ws);
		upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES ('c1', ?, 'test', 'active', ?, 'tmux', null, '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run(ws, wsId);
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4501,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: new Date().toISOString(),
		});
		updateBrokerDaemonPid(db, { collabId: "c1", pid: process.pid, pidStartTime: null, now: new Date().toISOString() });
		db.close();

		const out = await runCollabStatus({ cwd: ws });
		expect(out).toContain("c1");
		expect(out).toContain("4501");
		expect(out).toContain("active");
	});

	it("returns a clear message when nothing is registered for cwd", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "status-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const out = await runCollabStatus({ cwd: ws });
		expect(out).toContain("no active collab");
	});
});
