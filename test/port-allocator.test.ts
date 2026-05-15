import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { allocatePort } from "../packages/cli/src/runtime/port-allocator.ts";
import { insertBrokerDaemon } from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";

function freshDbWithCollab(id: string) {
	const dir = mkdtempSync(join(tmpdir(), "pa-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?, '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(id);
	return db;
}

describe("port-allocator", () => {
	it("picks the first port in range when registry is empty", async () => {
		const db = freshDbWithCollab("c1");
		const port = await allocatePort(db, { range: [4500, 4502], isPortFreeOs: async () => true });
		expect(port).toBe(4500);
	});

	it("skips ports already in broker_daemon", async () => {
		const db = freshDbWithCollab("c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		const port = await allocatePort(db, { range: [4500, 4502], isPortFreeOs: async () => true });
		expect(port).toBe(4501);
	});

	it("skips ports the OS reports as busy", async () => {
		const db = freshDbWithCollab("c1");
		const port = await allocatePort(db, {
			range: [4500, 4502],
			isPortFreeOs: async (p) => p === 4502,
		});
		expect(port).toBe(4502);
	});

	it("throws when range is exhausted", async () => {
		const db = freshDbWithCollab("c1");
		await expect(
			allocatePort(db, { range: [4500, 4500], isPortFreeOs: async () => false }),
		).rejects.toThrow(/No free port/);
	});
});
