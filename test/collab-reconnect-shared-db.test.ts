import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { upsertWorkspace, upsertSessionAttachment } from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { listReattachableSessions } from "../packages/cli/src/commands/collab/reconnect.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("listReattachableSessions", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("returns mounted + adopted attachments for the active collab", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "reconnect-"));
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
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: "/dev/ttys001",
			pid: 12345,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:00Z",
		});
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "claude",
			attachmentKind: "adopted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: "/dev/ttys002",
			pid: 12346,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:00Z",
		});
		db.close();

		const list = listReattachableSessions({ cwd: ws });
		expect(list.map((s) => s.agentType).sort()).toEqual(["claude", "codex"]);
	});
});
