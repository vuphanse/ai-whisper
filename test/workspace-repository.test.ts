import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	getWorkspaceById,
	getWorkspaceByRoot,
	listWorkspaces,
} from "../packages/broker/src/storage/repositories/workspace-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-workspace-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	return db;
}

describe("workspace-repository", () => {
	it("upserts and retrieves by id", () => {
		const db = freshDb();
		upsertWorkspace(db, {
			id: "abc123",
			workspaceRoot: "/tmp/x",
			now: "2026-05-15T00:00:00Z",
		});
		const row = getWorkspaceById(db, "abc123");
		expect(row?.workspaceRoot).toBe("/tmp/x");
		expect(row?.firstSeenAt).toBe("2026-05-15T00:00:00Z");
		expect(row?.lastSeenAt).toBe("2026-05-15T00:00:00Z");
	});

	it("updates last_seen_at on second upsert", () => {
		const db = freshDb();
		upsertWorkspace(db, { id: "abc", workspaceRoot: "/r", now: "2026-05-15T00:00:00Z" });
		upsertWorkspace(db, { id: "abc", workspaceRoot: "/r", now: "2026-05-16T00:00:00Z" });
		const row = getWorkspaceById(db, "abc");
		expect(row?.firstSeenAt).toBe("2026-05-15T00:00:00Z");
		expect(row?.lastSeenAt).toBe("2026-05-16T00:00:00Z");
	});

	it("looks up by workspace_root", () => {
		const db = freshDb();
		upsertWorkspace(db, { id: "abc", workspaceRoot: "/r", now: "2026-05-15T00:00:00Z" });
		expect(getWorkspaceByRoot(db, "/r")?.id).toBe("abc");
		expect(getWorkspaceByRoot(db, "/nope")).toBeNull();
	});

	it("lists workspaces ordered by last_seen_at descending", () => {
		const db = freshDb();
		upsertWorkspace(db, { id: "a", workspaceRoot: "/a", now: "2026-05-15T00:00:00Z" });
		upsertWorkspace(db, { id: "b", workspaceRoot: "/b", now: "2026-05-16T00:00:00Z" });
		const rows = listWorkspaces(db);
		expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
	});
});
