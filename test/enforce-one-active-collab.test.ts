import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { enforceOneActiveCollabPerWorkspace } from "../packages/broker/src/storage/enforce-one-active-collab.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "enforce-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	// applyMigrations now creates idx_collab_one_active_per_workspace. To seed the
	// pre-existing duplicate state these tests exercise — an incident-era DB that
	// predates the index — drop it first so the duplicate active rows can be
	// INSERTed. The function under test re-creates the index when it leaves the
	// workspace clean, which the index-backstop tests then assert.
	db.exec("DROP INDEX IF EXISTS idx_collab_one_active_per_workspace");
	return db;
}

function seedCollab(
	db: ReturnType<typeof openDatabase>,
	opts: {
		collabId: string;
		workspaceId: string;
		createdAt: string;
		status?: "active" | "stopped";
	},
) {
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 3)",
	).run(
		opts.collabId,
		`/ws/${opts.workspaceId}`,
		opts.collabId,
		opts.status ?? "active",
		opts.workspaceId,
		opts.createdAt,
		opts.createdAt,
	);
}

function seedRunningWorkflow(
	db: ReturnType<typeof openDatabase>,
	collabId: string,
	workflowId: string,
) {
	db.prepare(
		"INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at) VALUES (?, ?, 'spec-driven-development', '/spec.md', '{}', 'running', 0, '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')",
	).run(workflowId, collabId);
}

function seedDaemon(
	db: ReturnType<typeof openDatabase>,
	collabId: string,
	pid: number,
) {
	db.prepare(
		"INSERT INTO broker_daemon (collab_id, host, port, pid, started_at, last_heartbeat_at) VALUES (?, '127.0.0.1', ?, ?, '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')",
	).run(collabId, 4000 + (pid % 1000), pid);
}

function activeIds(db: ReturnType<typeof openDatabase>, workspaceId: string) {
	return (
		db
			.prepare(
				"SELECT collab_id FROM collab WHERE workspace_id = ? AND status = 'active' ORDER BY collab_id",
			)
			.all(workspaceId) as Array<{ collab_id: string }>
	).map((r) => r.collab_id);
}

describe("enforceOneActiveCollabPerWorkspace — dedup", () => {
	it("keeps the workflow-owning collab even when it is older (incident inverted)", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "older", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "newer", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });
		seedRunningWorkflow(db, "older", "wf1");

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(activeIds(db, "ws1")).toEqual(["older"]);
	});

	it("falls back to the live-daemon collab when no running workflow", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "dead", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });
		seedCollab(db, { collabId: "live", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedDaemon(db, "dead", 111);
		seedDaemon(db, "live", 222);

		enforceOneActiveCollabPerWorkspace(db, {
			isPidAlive: (pid) => pid === 222,
			warn: () => {},
		});

		expect(activeIds(db, "ws1")).toEqual(["live"]);
	});

	it("falls back to the newest when no running workflow and no live daemon", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "old", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "new", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(activeIds(db, "ws1")).toEqual(["new"]);
	});

	it("conflict: two running-workflow collabs both stay active and a warning is emitted", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "a", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "b", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });
		seedRunningWorkflow(db, "a", "wfa");
		seedRunningWorkflow(db, "b", "wfb");
		const warnings: string[] = [];

		enforceOneActiveCollabPerWorkspace(db, {
			isPidAlive: () => false,
			warn: (m) => warnings.push(m),
		});

		expect(activeIds(db, "ws1")).toEqual(["a", "b"]);
		expect(warnings.join("\n")).toContain("a");
		expect(warnings.join("\n")).toContain("b");
	});

	it("never deletes rows — non-survivors are flipped to stopped, not removed", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "old", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "new", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		const total = (db.prepare("SELECT COUNT(*) AS n FROM collab").get() as { n: number }).n;
		expect(total).toBe(2);
		const stopped = db
			.prepare("SELECT status FROM collab WHERE collab_id = 'old'")
			.get() as { status: string };
		expect(stopped.status).toBe("stopped");
	});

	it("leaves a single active collab per workspace untouched", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "solo", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(activeIds(db, "ws1")).toEqual(["solo"]);
	});

	it("treats distinct workspaces independently", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "x", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "y", workspaceId: "ws2", createdAt: "2026-05-24T23:16:00Z" });

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(activeIds(db, "ws1")).toEqual(["x"]);
		expect(activeIds(db, "ws2")).toEqual(["y"]);
	});
});

function indexExists(db: ReturnType<typeof openDatabase>): boolean {
	const row = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_collab_one_active_per_workspace'",
		)
		.get();
	return row !== undefined;
}

describe("enforceOneActiveCollabPerWorkspace — index backstop", () => {
	it("creates the unique index when no residual duplicate remains", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "old", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "new", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });

		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(indexExists(db)).toBe(true);
	});

	it("the index rejects a direct second active insert for a workspace", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "solo", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });

		expect(() =>
			seedCollab(db, { collabId: "dupe", workspaceId: "ws1", createdAt: "2026-05-24T23:40:00Z" }),
		).toThrow(/UNIQUE constraint failed/);
	});

	it("skips the index (table-wide) when an irreducible conflict remains, without throwing", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "a", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "b", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });
		seedRunningWorkflow(db, "a", "wfa");
		seedRunningWorkflow(db, "b", "wfb");

		expect(() =>
			enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} }),
		).not.toThrow();
		expect(indexExists(db)).toBe(false);
		// Both runs still active — neither workflow orphaned.
		expect(activeIds(db, "ws1")).toEqual(["a", "b"]);
	});

	it("creates the index on a later run once the operator resolves the conflict", () => {
		const db = freshDb();
		seedCollab(db, { collabId: "a", workspaceId: "ws1", createdAt: "2026-05-24T23:16:00Z" });
		seedCollab(db, { collabId: "b", workspaceId: "ws1", createdAt: "2026-05-24T23:30:00Z" });
		seedRunningWorkflow(db, "a", "wfa");
		seedRunningWorkflow(db, "b", "wfb");

		// First run: conflict → no index.
		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });
		expect(indexExists(db)).toBe(false);

		// Operator stops the extra collab manually.
		db.prepare("UPDATE collab SET status = 'stopped' WHERE collab_id = 'b'").run();

		// Later run: clean → index created.
		enforceOneActiveCollabPerWorkspace(db, { isPidAlive: () => false, warn: () => {} });
		expect(indexExists(db)).toBe(true);
	});
});
