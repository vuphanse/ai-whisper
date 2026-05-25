import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	acquireCaptureLease,
	releaseCaptureLease,
	sweepStaleCaptureLease,
} from "../packages/broker/src/storage/clipboard-capture-lease.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "lease-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	return db;
}

const TTL_MS = 5000;
const T0 = Date.parse("2026-05-25T00:00:00Z");

describe("clipboard_capture_lease — schema", () => {
	it("creates the singleton lease table via migration", () => {
		const db = freshDb();
		const row = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='clipboard_capture_lease'",
			)
			.get() as { name: string } | undefined;
		expect(row?.name).toBe("clipboard_capture_lease");
	});

	it("enforces the singleton id constraint (only id=1 allowed)", () => {
		const db = freshDb();
		expect(() =>
			db
				.prepare(
					"INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at) VALUES (2, 'c', 1, '2026-05-25T00:00:00Z')",
				)
				.run(),
		).toThrow();
	});
});

describe("relay_capture_diagnostics — interference column", () => {
	it("adds interference_detected with a default of 0", () => {
		const db = freshDb();
		const cols = db
			.prepare("PRAGMA table_info(relay_capture_diagnostics)")
			.all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
		const col = cols.find((c) => c.name === "interference_detected");
		expect(col).toBeDefined();
		expect(col?.notnull).toBe(1);
		expect(col?.dflt_value).toBe("0");
	});
});

describe("clipboard_capture_lease — acquire/release", () => {
	it("acquires when free", () => {
		const db = freshDb();
		const ok = acquireCaptureLease(db, "collabA", 100, {
			isPidAlive: () => true,
			ttlMs: TTL_MS,
			now: () => T0,
		});
		expect(ok).toBe(true);
	});

	it("blocks a second holder while the first is live and within TTL", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		expect(acquireCaptureLease(db, "collabA", 100, opts)).toBe(true);
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBe(false);
	});

	it("reclaims when the holder pid is dead", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBe(true);
		// collabA's pid (100) is dead; collabB (200) is alive.
		expect(
			acquireCaptureLease(db, "collabB", 200, {
				isPidAlive: (pid) => pid === 200,
				ttlMs: TTL_MS,
				now: () => T0 + 10,
			}),
		).toBe(true);
	});

	it("reclaims when acquired_at exceeds TTL even if pid is alive", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBe(true);
		expect(
			acquireCaptureLease(db, "collabB", 200, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0 + TTL_MS + 1,
			}),
		).toBe(true);
	});

	it("release clears the holder so the next acquire succeeds", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		expect(acquireCaptureLease(db, "collabA", 100, opts)).toBe(true);
		releaseCaptureLease(db, "collabA");
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBe(true);
	});

	it("release by a non-holder is a no-op (does not free another's lease)", () => {
		const db = freshDb();
		const opts = { isPidAlive: () => true, ttlMs: TTL_MS, now: () => T0 };
		expect(acquireCaptureLease(db, "collabA", 100, opts)).toBe(true);
		releaseCaptureLease(db, "collabB"); // not the holder
		expect(acquireCaptureLease(db, "collabB", 200, opts)).toBe(false);
	});
});

describe("clipboard_capture_lease — startup sweep", () => {
	it("applyMigrations reclaims a stale singleton row left by a dead pid", () => {
		const db = freshDb();
		// Seed a held lease whose holder pid is (assumed) dead.
		db.prepare(
			"INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at) VALUES (1, 'deadCollab', 999999, '2026-05-25T00:00:00Z')",
		).run();
		// applyMigrations runs the sweep; the row's pid is long dead, so it clears.
		applyMigrations(db);
		const row = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(row.holder_collab_id).toBeNull();
	});

	it("sweepStaleCaptureLease leaves a live, within-TTL holder untouched", () => {
		const db = freshDb();
		expect(
			acquireCaptureLease(db, "collabA", 100, {
				isPidAlive: () => true,
				ttlMs: TTL_MS,
				now: () => T0,
			}),
		).toBe(true);
		sweepStaleCaptureLease(db, {
			isPidAlive: () => true,
			ttlMs: TTL_MS,
			now: () => T0 + 1,
		});
		const row = db
			.prepare("SELECT holder_collab_id FROM clipboard_capture_lease WHERE id = 1")
			.get() as { holder_collab_id: string | null };
		expect(row.holder_collab_id).toBe("collabA");
	});
});
