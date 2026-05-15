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
});
