import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("multi-workspace collabs", () => {
	let stateRoot: string;
	beforeEach(() => {
		stateRoot = mkdtempSync(path.join(os.tmpdir(), "mw-"));
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
	});

	const fakeSpawn = (collabId: string, pid: number) => {
		const db = openDatabase(getSharedSqlitePath());
		db.prepare(
			"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
		).run(pid, new Date().toISOString(), collabId);
		db.close();
	};

	it("starts three collabs in three workspaces, isolates them, stops one without touching the others", async () => {
		const w1 = path.join(stateRoot, "w1");
		const w2 = path.join(stateRoot, "w2");
		const w3 = path.join(stateRoot, "w3");
		mkdirSync(w1);
		mkdirSync(w2);
		mkdirSync(w3);

		let clock = Date.parse("2026-05-01T00:00:00.000Z");
		const opts = (pid: number) => ({
			displayName: "t",
			launchMode: "none" as const,
			now: () => new Date((clock += 1000)).toISOString(),
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }: { collabId: string }) => {
				fakeSpawn(collabId, pid);
				return pid;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		});

		const r1 = await runCollabStart({ cwd: w1, ...opts(1001) });
		const r2 = await runCollabStart({ cwd: w2, ...opts(1002) });
		const r3 = await runCollabStart({ cwd: w3, ...opts(1003) });

		expect(new Set([r1.port, r2.port, r3.port]).size).toBe(3);

		const s1 = runCollabStatus({ cwd: w1 });
		const s2 = runCollabStatus({ cwd: w2 });
		expect(s1).toContain(r1.collabId);
		expect(s1).not.toContain(r2.collabId);
		expect(s2).toContain(r2.collabId);
		expect(s2).not.toContain(r1.collabId);

		runCollabStop({
			cwd: w2,
			now: () => new Date().toISOString(),
			signalProcess: () => {},
		});

		const after1 = runCollabStatus({ cwd: w1 });
		const after3 = runCollabStatus({ cwd: w3 });
		const after2 = runCollabStatus({ cwd: w2 });
		// w1 and w3 untouched: still active. w2 stopped: status flips to
		// stopped (the row persists, so the resolver still finds it by cwd).
		expect(after1).toContain("status: active");
		expect(after3).toContain("status: active");
		expect(after2).toContain("status: stopped");
		expect(after2).not.toContain("status: active");
	});

	it("blocks a second start in the same workspace until stop runs", async () => {
		const w = path.join(stateRoot, "ws");
		mkdirSync(w);
		let clock = Date.parse("2026-05-02T00:00:00.000Z");
		const opts = (pid: number) => ({
			cwd: w,
			displayName: "t",
			launchMode: "none" as const,
			now: () => new Date((clock += 1000)).toISOString(),
			isPortFreeOs: async () => true,
			spawnBroker: ({ collabId }: { collabId: string }) => {
				fakeSpawn(collabId, pid);
				return pid;
			},
			waitForReady: async () => true,
			signalProcess: () => {},
		});
		await runCollabStart(opts(2001));
		await expect(runCollabStart(opts(2002))).rejects.toThrow(/already exists/);
		runCollabStop({
			cwd: w,
			now: () => new Date().toISOString(),
			signalProcess: () => {},
		});
		await expect(runCollabStart(opts(2003))).resolves.toBeTruthy();
	});
});
