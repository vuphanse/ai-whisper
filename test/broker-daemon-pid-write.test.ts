import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { writeOwnPidToBrokerDaemon } from "../packages/cli/src/runtime/process-start-time.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "pid-"));
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

describe("writeOwnPidToBrokerDaemon", () => {
	it("populates pid and pid_start_time on the row", () => {
		const db = freshDb();
		writeOwnPidToBrokerDaemon(db, { collabId: "c1", now: "2026-05-15T00:00:05Z" });
		const row = getBrokerDaemonByCollab(db, "c1");
		expect(row?.pid).toBe(process.pid);
		expect(row?.lastHeartbeatAt).toBe("2026-05-15T00:00:05Z");
	});
});
