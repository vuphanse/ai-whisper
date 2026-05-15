import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	insertBrokerDaemon,
	upsertWorkspace,
} from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { CollabResolverError } from "../packages/cli/src/runtime/collab-resolver.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";
import { registerLaunchedBindings } from "./helpers/register-launched-bindings.ts";

describe("runCollabTell via shared DB", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("throws NoLiveDaemonForCollab when broker_daemon row has pid IS NULL", async () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "tell-shared-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		const ws = path.join(tmp, "ws");
		mkdirSync(ws);
		const db = openDatabase(getSharedSqlitePath());
		applyMigrations(db);
		const wsId = workspaceIdFromPath(ws);
		upsertWorkspace(db, { id: wsId, workspaceRoot: ws, now: "2026-05-15T00:00:00Z" });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES ('c1', ?, 'test', 'active', ?, 'terminals', null, '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
		).run(ws, wsId);
		// broker_daemon row exists but pid IS NULL → no live daemon.
		insertBrokerDaemon(db, {
			collabId: "c1",
			host: "127.0.0.1",
			port: 4500,
			startedAt: "2026-05-15T00:00:00Z",
			lastHeartbeatAt: "2026-05-15T00:00:00Z",
		});
		db.close();

		await expect(
			runCollabTell({
				cwd: ws,
				target: "codex",
				instruction: "review",
				artifactPaths: [],
				now: "2026-05-15T00:00:01Z",
			}),
		).rejects.toBeInstanceOf(CollabResolverError);

		try {
			await runCollabTell({
				cwd: ws,
				target: "codex",
				instruction: "review",
				artifactPaths: [],
				now: "2026-05-15T00:00:01Z",
			});
		} catch (err) {
			expect((err as CollabResolverError).kind).toBe("NoLiveDaemonForCollab");
		}
	});

	it("resolves via shared DB and returns a provider-backed reply", async () => {
		const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "tell-shared-ok-"));
		const planPath = path.join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await startCollabForTest({
			workspaceRoot,
			now: "2026-05-15T00:00:00.000Z",
			launchMode: "terminals",
		});
		await registerLaunchedBindings({
			workspaceRoot,
			now: "2026-05-15T00:00:00.500Z",
		});

		const reply = await runCollabTell({
			cwd: workspaceRoot,
			target: "codex",
			instruction: "review this plan",
			explicitAction: "review_plan",
			artifactPaths: [planPath],
			threadTitle: "Review plan",
			providerOverride: createMockProvider(),
			now: "2026-05-15T00:00:01.000Z",
		});

		expect(reply).toMatchObject({ kind: "review" });
	});
});
