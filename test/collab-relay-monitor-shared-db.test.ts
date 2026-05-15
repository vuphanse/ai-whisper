import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { upsertWorkspace } from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { resolveRelayMonitorTargets } from "../packages/cli/src/commands/collab/relay-monitor.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("resolveRelayMonitorTargets", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("returns the active collab's sqlitePath and collabId", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "relay-mon-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const sqlitePath = getSharedSqlitePath();
		const db = openDatabase(sqlitePath);
		applyMigrations(db);
		const wsId = workspaceIdFromPath(ws);
		upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES ('c1', ?, 't', 'active', ?, 'none', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run(ws, wsId);
		db.close();

		const targets = resolveRelayMonitorTargets({ cwd: ws });
		expect(targets.collabId).toBe("c1");
		expect(targets.sqlitePath).toBe(sqlitePath);
	});
});
