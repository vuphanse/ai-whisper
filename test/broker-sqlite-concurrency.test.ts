import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

describe("broker sqlite concurrency", () => {
	it("serializes concurrent writers across connections without SQLITE_BUSY", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-sqlite-busy-"));
		const path = join(dir, "broker.sqlite");

		const writer = openDatabase(path);
		writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");

		// Process A: hold a write transaction for ~200ms.
		const blockerDone = new Promise<void>((resolve) => {
			setTimeout(() => {
				const tx = writer.transaction((end: number) => {
					for (let i = 0; i < end; i += 1) {
						writer.prepare("INSERT INTO t (v) VALUES (?)").run(i);
					}
				});
				tx(50);
				resolve();
			}, 0);
		});

		// Process B: open a second connection and attempt a write ~20ms later —
		// while A still holds the lock. Without busy_timeout this throws
		// SqliteError { code: 'SQLITE_BUSY' }.
		const secondary = openDatabase(path);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(() =>
			secondary.prepare("INSERT INTO t (v) VALUES (?)").run(999),
		).not.toThrow();

		await blockerDone;

		const rows = secondary
			.prepare("SELECT COUNT(*) AS n FROM t")
			.get() as { n: number };
		expect(rows.n).toBe(51);

		writer.close();
		secondary.close();
	});
});
