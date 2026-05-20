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
	upsertRecoveryState,
} from "../packages/broker/src/index.ts";
import { upsertSessionBinding } from "../packages/broker/src/storage/repositories/session-binding-repository.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

type AgentEntry = { agentType: string; bindingState: string | null };

type StatusJsonShape = {
	collabId: string;
	workspaceRoot: string;
	status: string;
	daemon: { host: string; port: number; pid: number } | null;
	agents: AgentEntry[];
	recovery: { state: string };
};

type ErrorJsonShape = {
	error: string;
	cwd: string;
};

function makeSandbox() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "status-json-"));
	process.env.AI_WHISPER_STATE_ROOT = tmp;
	const ws = path.join(tmp, "ws");
	mkdirSync(ws);
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
	return { tmp, ws, db, wsId };
}

function insertCollab(
	db: ReturnType<typeof openDatabase>,
	collabId: string,
	ws: string,
	wsId: string,
) {
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'test', 'active', ?, 'tmux', null, '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run(collabId, ws, wsId);
}

describe("runCollabStatus --json", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("emits the documented JSON shape with literal storage-layer enum values", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_status_x";
		insertCollab(db, collabId, ws, wsId);

		insertBrokerDaemon(db, {
			collabId,
			host: "127.0.0.1",
			port: 4599,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: new Date().toISOString(),
		});
		updateBrokerDaemonPid(db, {
			collabId,
			pid: 12345,
			pidStartTime: null,
			now: new Date().toISOString(),
		});

		// codex bound; claude absent (null)
		upsertSessionBinding(db, {
			version: 1,
			collabId,
			agentType: "codex",
			bindingState: "bound",
			activeSessionId: null,
			bindingSource: null,
			targetTtyPath: null,
			pendingClaimId: null,
			pendingClaimExpiresAt: null,
			updatedAt: new Date().toISOString(),
		});

		upsertRecoveryState(db, {
			collabId,
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});

		db.close();

		const parsed = JSON.parse(runCollabStatus({ cwd: ws, json: true })) as StatusJsonShape;

		expect(parsed.collabId).toBe(collabId);
		expect(parsed.workspaceRoot).toBe(ws);
		expect(parsed.status).toBe("active");
		expect(parsed.daemon).toMatchObject({
			host: expect.any(String),
			port: expect.any(Number),
			pid: expect.any(Number),
		});
		// Literal storage-layer enum values — NOT remapped
		expect(parsed.agents).toEqual(
			expect.arrayContaining([
				{ agentType: "codex", bindingState: "bound" },
				{ agentType: "claude", bindingState: null },
			]),
		);
		expect(parsed.recovery).toEqual({ state: "normal" });
	});

	it("daemon is null when broker_daemon row is absent", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_no_daemon";
		insertCollab(db, collabId, ws, wsId);
		db.close();

		const parsed = JSON.parse(runCollabStatus({ cwd: ws, json: true })) as StatusJsonShape;

		expect(parsed.daemon).toBeNull();
	});

	it("recovery.state passes through 'recovery_required' verbatim", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_rr";
		insertCollab(db, collabId, ws, wsId);
		upsertRecoveryState(db, {
			collabId,
			state: "recovery_required",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
		db.close();

		const parsed = JSON.parse(runCollabStatus({ cwd: ws, json: true })) as StatusJsonShape;

		expect(parsed.recovery).toEqual({ state: "recovery_required" });
	});

	it("recovery.state passes through 'recovered' verbatim", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_recovered";
		insertCollab(db, collabId, ws, wsId);
		upsertRecoveryState(db, {
			collabId,
			state: "recovered",
			idleAfterRecovery: false,
			recoveredAt: new Date().toISOString(),
		});
		db.close();

		const parsed = JSON.parse(runCollabStatus({ cwd: ws, json: true })) as StatusJsonShape;

		expect(parsed.recovery).toEqual({ state: "recovered" });
	});

	it("bindingState 'pending_attach' is preserved (not remapped to 'pending')", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_pending";
		insertCollab(db, collabId, ws, wsId);
		upsertSessionBinding(db, {
			version: 1,
			collabId,
			agentType: "codex",
			bindingState: "pending_attach",
			activeSessionId: null,
			bindingSource: null,
			targetTtyPath: null,
			pendingClaimId: null,
			pendingClaimExpiresAt: null,
			updatedAt: new Date().toISOString(),
		});
		db.close();

		const parsed = JSON.parse(runCollabStatus({ cwd: ws, json: true })) as StatusJsonShape;

		const codexAgent = parsed.agents.find((a) => a.agentType === "codex");
		expect(codexAgent?.bindingState).toBe("pending_attach");
	});

	it("plain-text output is unchanged when --json is not set", () => {
		const { ws, db, wsId } = makeSandbox();
		const collabId = "collab_text";
		insertCollab(db, collabId, ws, wsId);
		db.close();

		const output = runCollabStatus({ cwd: ws });

		expect(output).toContain("collabId:");
		expect(output).toContain("status:");
		expect(output).not.toContain("{"); // not JSON
	});

	it("no-collab branch emits { error: 'no_collab_for_cwd' } when --json", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "status-json-empty-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		// No DB file — existsSync check will fail

		const parsed = JSON.parse(
			runCollabStatus({ cwd: "/tmp/aiw-status-empty-dir", json: true }),
		) as ErrorJsonShape;

		expect(parsed).toEqual({ error: "no_collab_for_cwd", cwd: "/tmp/aiw-status-empty-dir" });
	});

	it("no-collab JSON error when DB exists but no collab for cwd", () => {
		const { db } = makeSandbox();
		// DB exists but no collab row — CollabResolverError(NoCollabFoundForCwd) path
		// (dir exists, so workspaceIdFromPath won't throw, but no collab row matches)
		const unregisteredWs = mkdtempSync(path.join(os.tmpdir(), "status-json-unreg-"));
		db.close();

		const parsed = JSON.parse(
			runCollabStatus({ cwd: unregisteredWs, json: true }),
		) as ErrorJsonShape;

		expect(parsed).toEqual({ error: "no_collab_for_cwd", cwd: unregisteredWs });
	});
});
