import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertWorkspace,
	insertBrokerDaemon,
	listSessionAttachmentsByCollab,
} from "../packages/broker/src/index.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { recordLaunchedSessions } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import type { LaunchResult } from "../packages/cli/src/runtime/launcher.ts";

function setupActiveCollab() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "launched-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(db, {
		id: wsId,
		workspaceRoot: ws,
		now: "2026-05-15T00:00:00Z",
	});
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES ('c1', ?, 't', 'active', ?, 'none', NULL, '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(ws, wsId);
	insertBrokerDaemon(db, {
		collabId: "c1",
		host: "127.0.0.1",
		port: 4500,
		startedAt: "2026-05-15T00:00:00Z",
		lastHeartbeatAt: "2026-05-15T00:00:00Z",
	});
	db.close();
	return { tmp, ws };
}

describe("recordLaunchedSessions", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("persists the launched tmux session so stop can kill it", async () => {
		const { ws } = setupActiveCollab();
		const launch: LaunchResult = {
			launched: true,
			launchMode: "tmux",
			commands: { codex: "c", claude: "cl", relayMonitor: "rm" },
			runtime: {},
			tmuxSession: "whisper-collab_x",
		};
		recordLaunchedSessions({
			collabId: "c1",
			launchMode: "tmux",
			launch,
		});

		const db = openDatabase(getSharedSqlitePath());
		const row = db
			.prepare("SELECT tmux_session FROM collab WHERE collab_id = 'c1'")
			.get() as { tmux_session: string | null };
		db.close();
		expect(row.tmux_session).toBe("whisper-collab_x");

		const commands: string[] = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: () => {},
			execCommand: (cmd) => commands.push(cmd),
		});
		expect(
			commands.some((c) =>
				c.includes("tmux kill-session -t 'whisper-collab_x'"),
			),
		).toBe(true);
	});

	it("persists owned terminal windows so stop can close and signal them", async () => {
		const { ws } = setupActiveCollab();
		const launch: LaunchResult = {
			launched: true,
			launchMode: "terminals",
			commands: { codex: "c", claude: "cl", relayMonitor: "rm" },
			runtime: {
				codexWindowLabel: "whisper-codex",
				codexPid: 5001,
				claudeWindowLabel: "whisper-claude",
				claudePid: 5002,
				relayMonitorWindowLabel: "whisper-relay-monitor",
				relayMonitorPid: 5003,
			},
		};
		recordLaunchedSessions({
			collabId: "c1",
			launchMode: "terminals",
			launch,
		});

		const db = openDatabase(getSharedSqlitePath());
		const rows = listSessionAttachmentsByCollab(db, "c1").filter(
			(a) => a.attachmentKind === "owned",
		);
		db.close();
		expect(rows).toHaveLength(2);
		const codex = rows.find((r) => r.agentType === "codex");
		const claude = rows.find((r) => r.agentType === "claude");
		expect(codex).toMatchObject({
			windowLabel: "whisper-codex",
			pid: 5001,
			launchMode: "terminals",
			providerId: "codex",
		});
		expect(claude).toMatchObject({
			windowLabel: "whisper-claude",
			pid: 5002,
			launchMode: "terminals",
			providerId: "claude",
		});

		const signals: Array<{ pid: number; sig: string }> = [];
		const commands: string[] = [];
		await runCollabStop({
			cwd: ws,
			now: () => "2026-05-15T00:01:00Z",
			signalProcess: (pid, sig) => signals.push({ pid, sig }),
			execCommand: (cmd) => commands.push(cmd),
		});
		expect(signals).toContainEqual({ pid: 5001, sig: "SIGTERM" });
		expect(signals).toContainEqual({ pid: 5002, sig: "SIGTERM" });
		expect(commands.some((c) => c.includes("whisper-codex"))).toBe(true);
		expect(commands.some((c) => c.includes("whisper-claude"))).toBe(true);
	});
});
