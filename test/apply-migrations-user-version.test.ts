import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	applyMigrations,
	CURRENT_SCHEMA_VERSION,
} from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "ver-"));
	return openDatabase(join(dir, "broker.sqlite"));
}

describe("apply-migrations: PRAGMA user_version", () => {
	it("sets user_version to CURRENT_SCHEMA_VERSION on a fresh DB", () => {
		const db = freshDb();
		applyMigrations(db);
		const v = db.pragma("user_version", { simple: true }) as number;
		expect(v).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("is a no-op when called twice", () => {
		const db = freshDb();
		applyMigrations(db);
		applyMigrations(db);
		const v = db.pragma("user_version", { simple: true }) as number;
		expect(v).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("still writes broker_state for backward compatibility", () => {
		const db = freshDb();
		applyMigrations(db);
		const row = db
			.prepare("SELECT schema_version, migrated FROM broker_state WHERE id = 1")
			.get() as { schema_version: number; migrated: number } | undefined;
		expect(row?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
		expect(row?.migrated).toBe(1);
	});

	it("a persisted older-version DB re-runs the body and gains new schema", () => {
		const db = freshDb();
		applyMigrations(db);
		// Simulate a DB created before the relay_monitor columns existed: drop
		// them and pin user_version back to an earlier schema.
		db.exec("ALTER TABLE collab DROP COLUMN relay_monitor_window_label");
		db.exec("ALTER TABLE collab DROP COLUMN relay_monitor_pid");
		db.pragma("user_version = 2");

		applyMigrations(db);

		const cols = (
			db.prepare("PRAGMA table_info(collab)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("relay_monitor_window_label");
		expect(cols).toContain("relay_monitor_pid");
		expect(db.pragma("user_version", { simple: true })).toBe(
			CURRENT_SCHEMA_VERSION,
		);
	});

	it("fresh DB has evaluator_status column in broker_daemon", () => {
		const db = freshDb();
		applyMigrations(db);
		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
	});

	it("upgrade from v3: broker_daemon without evaluator_status gains the column", () => {
		const db = freshDb();
		applyMigrations(db);
		// Simulate a v3 DB that lacked the column: drop it and roll back user_version.
		db.exec("ALTER TABLE broker_daemon DROP COLUMN evaluator_status");
		db.pragma("user_version = 3");

		applyMigrations(db);

		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
		expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
	});

	it("calling applyMigrations twice on a fresh DB is a no-op (idempotent)", () => {
		const db = freshDb();
		applyMigrations(db);
		expect(() => applyMigrations(db)).not.toThrow();
		const cols = (
			db.prepare("PRAGMA table_info(broker_daemon)").all() as Array<{ name: string }>
		).map((c) => c.name);
		expect(cols).toContain("evaluator_status");
	});
});
