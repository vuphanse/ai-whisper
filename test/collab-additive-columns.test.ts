import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "collab-cols-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	return db;
}

describe("collab additive columns", () => {
	it("has workspace_id, stopped_at, launch_mode, tmux_session columns", () => {
		const db = freshDb();
		const cols = db
			.prepare("PRAGMA table_info(collab)")
			.all()
			.map((c: any) => c.name as string);
		expect(cols).toContain("workspace_id");
		expect(cols).toContain("stopped_at");
		expect(cols).toContain("launch_mode");
		expect(cols).toContain("tmux_session");
	});

	it("preserves existing status column with NOT NULL", () => {
		const db = freshDb();
		const cols = db.prepare("PRAGMA table_info(collab)").all() as Array<{
			name: string;
			notnull: number;
		}>;
		const status = cols.find((c) => c.name === "status");
		expect(status?.notnull).toBe(1);
	});

	it("has index on workspace_id + status", () => {
		const db = freshDb();
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='collab'")
			.all()
			.map((r: any) => r.name as string);
		expect(indexes).toContain("collab_by_workspace");
	});
});
