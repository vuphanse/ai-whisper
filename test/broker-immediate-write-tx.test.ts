import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

// Regression guard for the shared-state.db concurrency bug: with all collabs
// sharing one database, two mount commands ran read->write control
// transactions concurrently. A DEFERRED transaction takes its read snapshot
// first, and if another connection commits before its first write, SQLite
// fails the write with SQLITE_BUSY_SNAPSHOT *immediately* (busy_timeout does
// not apply to a stale-snapshot upgrade). The control service now runs its
// write transactions with BEGIN IMMEDIATE so the write lock is held from the
// start and contenders wait on busy_timeout instead of crashing.

function freshDbPair() {
	const dir = mkdtempSync(join(tmpdir(), "imm-tx-"));
	const path = join(dir, "state.db");
	const a = openDatabase(path);
	const b = openDatabase(path);
	a.exec("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
	return { a, b };
}

describe("shared-db write transaction mode", () => {
	it("DEFERRED read-then-write fails with SQLITE_BUSY_SNAPSHOT when another connection commits in between", () => {
		const { a, b } = freshDbPair();
		a.exec("BEGIN DEFERRED");
		// Take the read snapshot.
		a.prepare("SELECT count(*) AS n FROM t").get();
		// Another connection commits a write (autocommit) after the snapshot.
		b.prepare("INSERT INTO t (v) VALUES (1)").run();

		let code: string | undefined;
		try {
			a.prepare("INSERT INTO t (v) VALUES (2)").run();
		} catch (err) {
			code = (err as { code?: string }).code;
		} finally {
			a.exec("ROLLBACK");
		}
		expect(code).toBe("SQLITE_BUSY_SNAPSHOT");
		a.close();
		b.close();
	});

	it("IMMEDIATE transaction holds the write lock from BEGIN and commits without a snapshot conflict", () => {
		const { a, b } = freshDbPair();
		const txn = a.transaction(() => {
			a.prepare("SELECT count(*) AS n FROM t").get();
			a.prepare("INSERT INTO t (v) VALUES (10)").run();
		});

		// IMMEDIATE acquires the write lock at BEGIN; no read->write upgrade,
		// so an interleaving committed write cannot invalidate the snapshot.
		expect(() => txn.immediate()).not.toThrow();

		// A second connection writes afterwards, serialized cleanly.
		b.prepare("INSERT INTO t (v) VALUES (20)").run();
		const rows = a.prepare("SELECT v FROM t ORDER BY v").all() as Array<{
			v: number;
		}>;
		expect(rows.map((r) => r.v)).toEqual([10, 20]);
		a.close();
		b.close();
	});
});
