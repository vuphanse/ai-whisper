import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	getBrokerDaemonByCollab,
	insertBrokerDaemon,
	updateBrokerDaemonPid,
} from "../packages/broker/src/storage/repositories/broker-daemon-repository.ts";
import { sweepStaleBrokerDaemons } from "../packages/broker/src/runtime/broker-daemon-sweep.ts";

function freshDb(id: string) {
	const dir = mkdtempSync(join(tmpdir(), "bds-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES (?, '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(id);
	return db;
}

describe("broker-daemon-sweep", () => {
	it("deletes a stale pid IS NULL reservation without calling isAlive", async () => {
		const db = freshDb("c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		const isAlive = vi.fn();
		await sweepStaleBrokerDaemons({
			db,
			cutoffIso: "2026-05-15T00:01:30Z",
			isAlive,
		});
		expect(isAlive).not.toHaveBeenCalled();
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
	});

	it("deletes a stale row whose PID is dead", async () => {
		const db = freshDb("c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 1234,
			pidStartTime: "X",
			now: "2026-05-15T00:00:00Z",
		});
		await sweepStaleBrokerDaemons({
			db,
			cutoffIso: "2026-05-15T00:01:30Z",
			isAlive: async () => ({ alive: false, startTime: null }),
		});
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
	});

	it("deletes a stale row whose PID was reused (start_time differs)", async () => {
		const db = freshDb("c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 1234,
			pidStartTime: "X",
			now: "2026-05-15T00:00:00Z",
		});
		await sweepStaleBrokerDaemons({
			db,
			cutoffIso: "2026-05-15T00:01:30Z",
			isAlive: async () => ({ alive: true, startTime: "Y" }),
		});
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
	});

	it("keeps the row when PID matches and start_time matches", async () => {
		const db = freshDb("c1");
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid: 1234,
			pidStartTime: "X",
			now: "2026-05-15T00:00:00Z",
		});
		await sweepStaleBrokerDaemons({
			db,
			cutoffIso: "2026-05-15T00:01:30Z",
			isAlive: async () => ({ alive: true, startTime: "X" }),
		});
		expect(getBrokerDaemonByCollab(db, "c1")).not.toBeNull();
	});
});
