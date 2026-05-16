import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getBrokerDaemonByCollab,
	openDatabase,
} from "@ai-whisper/broker";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("broker lifecycle", () => {
	it("start records broker PID in the shared DB", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-broker-pid-"));

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		const db = openDatabase(getSharedSqlitePath());
		try {
			const row = getBrokerDaemonByCollab(db, result.collabId);
			expect(row?.pid).toBeTypeOf("number");
			expect(row!.pid!).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});

	it("stop kills the broker process and clears the daemon row", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-broker-stop-"),
		);

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		await runCollabStop({
			cwd: workspaceRoot,
			now: () => "2026-04-03T00:01:00.000Z",
			signalProcess: () => {},
		});

		const db = openDatabase(getSharedSqlitePath());
		try {
			const row = getBrokerDaemonByCollab(db, result.collabId);
			expect(row).toBeNull();
		} finally {
			db.close();
		}
	});
});
