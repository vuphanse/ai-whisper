import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	insertBrokerDaemon,
	openDatabase,
	upsertRecoveryState,
	upsertSessionAttachment,
	upsertWorkspace,
} from "@ai-whisper/broker";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import {
	canonicalWorkspaceRoot,
	workspaceIdFromPath,
} from "../packages/cli/src/runtime/workspace-id.ts";

function tempStateRoot(): string {
	return mkdtempSync(join(tmpdir(), "aiw-mount-stale-"));
}

/**
 * Seed an active collab + broker_daemon + recovery row directly in the
 * shared DB so runCollabMount's tryResolve() succeeds without spawning a
 * real broker daemon process. Mirrors test/collab-mount-passthrough-args.ts.
 */
function seedActiveCollab(workspaceRoot: string): string {
	const now = new Date().toISOString();
	const workspaceId = workspaceIdFromPath(workspaceRoot);
	const canonical = canonicalWorkspaceRoot(workspaceRoot);
	const collabId = `collab_${now.replace(/[^0-9]/g, "")}_seed`;
	const db = openDatabase(getSharedSqlitePath());
	try {
		applyMigrations(db);
		upsertWorkspace(db, { id: workspaceId, workspaceRoot: canonical, now });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, ?, ?, 'active', ?, 'none', NULL, ?, ?, 1, 3)",
		).run(collabId, canonical, "ws-seed", workspaceId, now, now);
		insertBrokerDaemon(db, {
			collabId,
			host: "127.0.0.1",
			port: 4734,
			startedAt: now,
			lastHeartbeatAt: now,
		});
		// Live pid so the resolver / heartbeat checks don't mark it stale.
		db.prepare("UPDATE broker_daemon SET pid = ? WHERE collab_id = ?").run(
			process.pid,
			collabId,
		);
		upsertRecoveryState(db, {
			collabId,
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	} finally {
		db.close();
	}
	return collabId;
}

/**
 * Seed a "bound" session_binding for codex directly (mirrors what
 * completeAttachClaim would leave behind after a mount).
 */
function seedBoundBinding(collabId: string): void {
	const now = new Date().toISOString();
	const db = openDatabase(getSharedSqlitePath());
	try {
		db.prepare(
			`INSERT INTO session_binding
				(collab_id, agent_type, binding_state, active_session_id, binding_source,
				 target_tty_path, pending_claim_id, pending_claim_expires_at, updated_at)
			VALUES (?, 'codex', 'bound', 'session_codex_seed', 'mounted', NULL, NULL, NULL, ?)`,
		).run(collabId, now);
	} finally {
		db.close();
	}
}

/** Seed a mounted session_attachment for codex with a chosen pid. */
function seedMountedAttachment(collabId: string, pid: number): void {
	const now = new Date().toISOString();
	const db = openDatabase(getSharedSqlitePath());
	try {
		upsertSessionAttachment(db, {
			collabId,
			agentType: "codex",
			attachmentKind: "mounted",
			sessionId: "session_codex_seed",
			providerId: null,
			launchMode: null,
			ttyPath: "/dev/ttys001",
			pid,
			windowLabel: null,
			attachedAt: now,
		});
	} finally {
		db.close();
	}
}

const okBroker = async () =>
	({ pidAlive: true, httpReachable: true, ok: true }) as never;

describe("runCollabMount stale binding reclaim", () => {
	let prevStateRoot: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) {
			delete process.env.AI_WHISPER_STATE_ROOT;
		} else {
			process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
		}
	});

	it("reclaims a stale binding whose owning pid is dead", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-dead");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);
		seedBoundBinding(collabId);
		seedMountedAttachment(collabId, 999999);

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			isPidAlive: () => false,
		});

		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
	});

	it("still errors when the bound session has a live owner", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-live");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);
		seedBoundBinding(collabId);
		seedMountedAttachment(collabId, 12345);

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: okBroker,
				isPidAlive: () => true,
			}),
		).rejects.toThrow(/already bound/);

		expect(fakeRuntime.start).not.toHaveBeenCalled();
	});

	it("reclaims a bound binding with no attachment row", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-noattach");
		mkdirSync(workspaceRoot, { recursive: true });
		const collabId = seedActiveCollab(workspaceRoot);
		seedBoundBinding(collabId);
		// No session_attachment row inserted.

		const fakeRuntime = { start: vi.fn(async () => undefined) };

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: okBroker,
			isPidAlive: () => true,
		});

		expect(fakeRuntime.start).toHaveBeenCalledTimes(1);
	});
});
