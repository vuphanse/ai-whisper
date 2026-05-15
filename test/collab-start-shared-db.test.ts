import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	getBrokerDaemonByCollab,
	getWorkspaceById,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function setup() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "start-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	return { tmp, ws };
}

describe("runCollabStart (shared DB)", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("inserts workspace, collab, broker_daemon rows; waits for readiness; succeeds", async () => {
		const { ws } = setup();
		const result = await runCollabStart({
			cwd: ws,
			displayName: "test",
			launchMode: "none",
			now: () => "2026-05-15T00:00:00Z",
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }) => {
				const db = openDatabase(getSharedSqlitePath());
				db.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(12345, "2026-05-15T00:00:01Z", collabId);
				db.close();
				return 12345;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		});
		expect(result.collabId).toBeTruthy();
		expect(result.port).toBeGreaterThanOrEqual(4500);

		const db = openDatabase(getSharedSqlitePath());
		const wsId = workspaceIdFromPath(ws);
		expect(getWorkspaceById(db, wsId)).not.toBeNull();
		const daemon = getBrokerDaemonByCollab(db, result.collabId);
		expect(daemon?.pid).toBe(12345);
		db.close();
	});

	it("rejects when an active collab already exists for the workspace", async () => {
		const { ws } = setup();
		const opts = {
			cwd: ws,
			displayName: "test",
			launchMode: "none" as const,
			now: () => "2026-05-15T00:00:00Z",
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }: { collabId: string }) => {
				const db = openDatabase(getSharedSqlitePath());
				db.prepare(
					"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
				).run(1, "2026-05-15T00:00:01Z", collabId);
				db.close();
				return 1;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		};
		await runCollabStart(opts);
		await expect(runCollabStart(opts)).rejects.toThrow(/already exists/);
	});

	it("runs cleanup tx (status='stopped') when readiness times out", async () => {
		const { ws } = setup();
		await expect(
			runCollabStart({
				cwd: ws,
				displayName: "test",
				launchMode: "none",
				now: () => "2026-05-15T00:00:00Z",
				isPortFreeOs: async () => true,
				spawnBroker: () => 1,
				waitForReady: async () => false,
				signalProcess: () => {},
			}),
		).rejects.toThrow(/readiness/);

		const db = openDatabase(getSharedSqlitePath());
		const statuses = db
			.prepare("SELECT status FROM collab")
			.all() as Array<{ status: string }>;
		expect(statuses.every((s) => s.status === "stopped")).toBe(true);
		const daemons = db.prepare("SELECT * FROM broker_daemon").all();
		expect(daemons).toHaveLength(0);
		db.close();
	});
});
