import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { createDaemonHeartbeat } from "../packages/broker/src/runtime/daemon-heartbeat.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "hb-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c1', '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run();
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
	});
	return db;
}

describe("daemon-heartbeat", () => {
	it("updates last_heartbeat_at on each tick", async () => {
		vi.useFakeTimers();
		const db = freshDb();
		const hb = createDaemonHeartbeat({
			db,
			collabId: "c1",
			intervalMs: 100,
			now: () => "2026-05-15T00:00:42Z",
		});
		hb.start();
		await vi.advanceTimersByTimeAsync(100);
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.lastHeartbeatAt).toBe("2026-05-15T00:00:42Z");
		hb.stop();
		vi.useRealTimers();
	});

	it("stop is idempotent and prevents further updates", async () => {
		vi.useFakeTimers();
		const db = freshDb();
		const hb = createDaemonHeartbeat({
			db,
			collabId: "c1",
			intervalMs: 100,
			now: () => new Date().toISOString(),
		});
		hb.start();
		hb.stop();
		hb.stop();
		const before = getBrokerDaemonByCollab(db, "c1")?.lastHeartbeatAt;
		await vi.advanceTimersByTimeAsync(500);
		const after = getBrokerDaemonByCollab(db, "c1")?.lastHeartbeatAt;
		expect(after).toBe(before);
		vi.useRealTimers();
	});
});
