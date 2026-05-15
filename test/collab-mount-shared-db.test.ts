import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	listSessionAttachmentsByCollab,
	upsertWorkspace,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { recordMountedSession } from "../packages/cli/src/commands/collab/mount.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("recordMountedSession", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	function setup() {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "mount-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const db = openDatabase(getSharedSqlitePath());
		applyMigrations(db);
		const wsId = workspaceIdFromPath(ws);
		upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES ('c1', ?, 't', 'active', ?, 'tmux', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run(ws, wsId);
		db.close();
		return { tmp, ws };
	}

	it("writes a session_attachment row with kind='mounted'", async () => {
		const { ws } = setup();
		await recordMountedSession({
			cwd: ws,
			agentType: "codex",
			ttyPath: "/dev/ttys001",
			pid: 12345,
		});
		const db = openDatabase(getSharedSqlitePath());
		const rows = listSessionAttachmentsByCollab(db, "c1");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.attachmentKind).toBe("mounted");
		expect(rows[0]?.ttyPath).toBe("/dev/ttys001");
		expect(rows[0]?.pid).toBe(12345);
		db.close();
	});

	it("upserts when called twice for the same agent", async () => {
		const { ws } = setup();
		await recordMountedSession({ cwd: ws, agentType: "codex", ttyPath: "/dev/ttys001", pid: 100 });
		await recordMountedSession({ cwd: ws, agentType: "codex", ttyPath: "/dev/ttys002", pid: 200 });
		const db = openDatabase(getSharedSqlitePath());
		const rows = listSessionAttachmentsByCollab(db, "c1");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ttyPath).toBe("/dev/ttys002");
		expect(rows[0]?.pid).toBe(200);
		db.close();
	});
});
