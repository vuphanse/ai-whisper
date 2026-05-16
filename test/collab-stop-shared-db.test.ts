import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	getBrokerDaemonByCollab,
	upsertSessionAttachment,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

function setupActiveCollab(
	pid: number | null,
	opts: { tmuxSession?: string } = {},
) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "stop-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES ('c1', ?, 't', 'active', ?, 'none', ?, '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(ws, wsId, opts.tmuxSession ?? null);
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
	});
	if (pid !== null) {
		updateBrokerDaemonPid(db, {
			collabId: "c1",
			pid,
			pidStartTime: null,
			now: "2026-05-15T00:00:00Z",
		});
	}
	db.close();
	return { tmp, ws };
}

describe("runCollabStop", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("deletes broker_daemon row, marks collab stopped, and signals the live daemon", async () => {
		const { ws } = setupActiveCollab(12345);
		const signals: Array<{ pid: number; sig: string }> = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
		});
		const db = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
		const row = db
			.prepare("SELECT status, stopped_at FROM collab WHERE collab_id = 'c1'")
			.get() as { status: string; stopped_at: string };
		expect(row.status).toBe("stopped");
		expect(row.stopped_at).toBe("2026-05-15T00:01:00Z");
		db.close();
		expect(signals).toEqual([{ pid: 12345, sig: "SIGTERM" }]);
	});

	it("orphan pid IS NULL row is removed without signaling", async () => {
		const { ws } = setupActiveCollab(null);
		const signals: Array<{ pid: number; sig: string }> = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
		});
		const db = openDatabase(getSharedSqlitePath());
		expect(getBrokerDaemonByCollab(db, "c1")).toBeNull();
		db.close();
		expect(signals).toEqual([]);
	});

	it("kills the tmux session recorded on the collab row", async () => {
		const { ws } = setupActiveCollab(12345, { tmuxSession: "aiw-c1" });
		const commands: string[] = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: () => {},
			execCommand: (cmd) => commands.push(cmd),
		});
		expect(
			commands.some((c) => c.includes("tmux kill-session -t 'aiw-c1'")),
		).toBe(true);
	});

	it("signals attachment pids and closes their terminal windows", async () => {
		const { ws } = setupActiveCollab(12345);
		const db = openDatabase(getSharedSqlitePath());
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: "terminals",
			ttyPath: "/dev/ttys001",
			pid: 4001,
			windowLabel: "aiw-codex-c1",
			attachedAt: "2026-05-15T00:00:00Z",
		});
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "claude",
			attachmentKind: "owned",
			sessionId: null,
			providerId: null,
			launchMode: "tmux",
			ttyPath: null,
			pid: 4002,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:01Z",
		});
		db.close();

		const signals: Array<{ pid: number; sig: string }> = [];
		const commands: string[] = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
			execCommand: (cmd) => commands.push(cmd),
		});

		// Broker daemon (12345) plus both attachment pids signaled SIGTERM.
		expect(signals).toContainEqual({ pid: 4001, sig: "SIGTERM" });
		expect(signals).toContainEqual({ pid: 4002, sig: "SIGTERM" });
		expect(signals).toContainEqual({ pid: 12345, sig: "SIGTERM" });
		// Window with a label gets closed; the label-less one does not.
		expect(commands.some((c) => c.includes("aiw-codex-c1"))).toBe(true);
	});
});
