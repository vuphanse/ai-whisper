import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertRecoveryState,
	getRecoveryState,
	deleteRecoveryState,
} from "../packages/broker/src/storage/repositories/recovery-state-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "rs-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c1', '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run();
	return db;
}

describe("recovery-state-repository", () => {
	it("upserts and reads back", () => {
		const db = freshDb();
		upsertRecoveryState(db, {
			collabId: "c1",
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
		const row = getRecoveryState(db, "c1");
		expect(row?.state).toBe("normal");
		expect(row?.idleAfterRecovery).toBe(false);
		expect(row?.recoveredAt).toBeNull();
	});

	it("updates an existing row on conflict", () => {
		const db = freshDb();
		upsertRecoveryState(db, {
			collabId: "c1",
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
		upsertRecoveryState(db, {
			collabId: "c1",
			state: "recovered",
			idleAfterRecovery: true,
			recoveredAt: "2026-05-15T00:01:00Z",
		});
		const row = getRecoveryState(db, "c1");
		expect(row?.state).toBe("recovered");
		expect(row?.idleAfterRecovery).toBe(true);
		expect(row?.recoveredAt).toBe("2026-05-15T00:01:00Z");
	});

	it("returns null for an unknown collab", () => {
		const db = freshDb();
		expect(getRecoveryState(db, "missing")).toBeNull();
	});

	it("deletes by collab id", () => {
		const db = freshDb();
		upsertRecoveryState(db, {
			collabId: "c1",
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
		expect(deleteRecoveryState(db, "c1")).toBe(1);
		expect(getRecoveryState(db, "c1")).toBeNull();
	});
});
