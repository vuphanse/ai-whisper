import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@ai-whisper/broker";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabRecover } from "../packages/cli/src/commands/collab/recover.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

function tempStateRoot(): string {
	return mkdtempSync(join(tmpdir(), "aiw-mount-readopt-"));
}

// Stubbed start: does the DB-level work of a real start without forking a daemon.
const stubbedRunStart: typeof runCollabStart = async (opts) =>
	runCollabStart({
		...opts,
		spawnBroker: (input) => {
			const db = openDatabase(getSharedSqlitePath());
			db.prepare(
				"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
			).run(91234, new Date().toISOString(), input.collabId);
			db.close();
			return 91234;
		},
		waitForReady: async () => true,
		isPortFreeOs: async () => true,
		signalProcess: () => {},
	});

// Stubbed recover: revives the dead daemon at the DB level (writes a live pid),
// mirroring what runCollabRecover does without forking a real broker.
const stubbedRunRecover: typeof runCollabRecover = async (opts) =>
	runCollabRecover({
		...opts,
		spawnBroker: (input) => {
			const db = openDatabase(getSharedSqlitePath());
			db.prepare(
				"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
			).run(95678, new Date().toISOString(), input.collabId);
			db.close();
			return 95678;
		},
		waitForReady: async () => true,
		isPortFreeOs: async () => true,
		signalProcess: () => {},
		isAlive: async () => ({ alive: false, startTime: null }),
		// A real post-restart dead daemon has a stale heartbeat; recover would
		// otherwise treat a fresh-heartbeat null-pid row as "recovery in progress".
		staleThresholdMs: 0,
	});

describe("runCollabMount re-adopt", () => {
	let prevStateRoot: string | undefined;
	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
	});

	function activeCount(workspaceRoot: string): number {
		const db = openDatabase(getSharedSqlitePath());
		const wsId = workspaceIdFromPath(workspaceRoot);
		const n = (
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM collab WHERE workspace_id = ? AND status = 'active'",
				)
				.get(wsId) as { n: number }
		).n;
		db.close();
		return n;
	}

	it("revives a dead-daemon collab and binds the agent without creating a second active row", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		// First mount: creates the collab with a live (stubbed) daemon.
		const fakeRuntime = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
		});
		expect(activeCount(workspaceRoot)).toBe(1);

		// Capture the collab id created by the first mount; the re-adopt must
		// bind into THIS id, not a freshly created one.
		const collabIdA = (() => {
			const db = openDatabase(getSharedSqlitePath());
			const row = db
				.prepare("SELECT collab_id FROM collab WHERE status = 'active'")
				.get() as { collab_id: string };
			db.close();
			return row.collab_id;
		})();

		// Simulate a machine restart: the daemon pid is gone (dead).
		{
			const db = openDatabase(getSharedSqlitePath());
			db.prepare("UPDATE broker_daemon SET pid = NULL").run();
			db.close();
		}

		// Second mount: must re-adopt the SAME collab via recover, not create a new one.
		const fakeRuntime2 = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime2 as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
			runRecoverFn: stubbedRunRecover,
			isPidAlive: () => true,
		});

		expect(activeCount(workspaceRoot)).toBe(1);
		expect(fakeRuntime2.start).toHaveBeenCalledTimes(1);
		const db = openDatabase(getSharedSqlitePath());
		// Live daemon is back on the re-adopted collab.
		const live = db
			.prepare("SELECT pid FROM broker_daemon WHERE collab_id = ?")
			.get(collabIdA) as { pid: number | null } | undefined;
		expect(live?.pid).not.toBeNull();
		// The agent was actually bound INTO the re-adopted collab: mount issued an
		// attach claim and moved the session_binding for the target agent on
		// collabIdA. A regression that revives the daemon but skips binding would
		// fail here (no claim / no pending_attach binding row on collabIdA).
		const binding = db
			.prepare(
				"SELECT collab_id, binding_state FROM session_binding WHERE collab_id = ? AND agent_type = 'codex'",
			)
			.get(collabIdA) as { collab_id: string; binding_state: string } | undefined;
		expect(binding).toBeDefined();
		// Claim issued but not consumed (fake runtime never registers), so the
		// binding rests at pending_attach; a real session would advance it to bound.
		expect(["pending_attach", "bound"]).toContain(binding?.binding_state);
		const claim = db
			.prepare(
				"SELECT collab_id FROM attach_claim WHERE collab_id = ? AND agent_type = 'codex' ORDER BY created_at DESC LIMIT 1",
			)
			.get(collabIdA) as { collab_id: string } | undefined;
		expect(claim?.collab_id).toBe(collabIdA);
		db.close();
	});

	it("revives a collab whose daemon has a stale NON-NULL dead PID and re-adopts it", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		// First mount creates the collab with a (stubbed) live daemon.
		const fakeRuntime = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
		});
		const collabIdA = (() => {
			const db = openDatabase(getSharedSqlitePath());
			const row = db
				.prepare("SELECT collab_id FROM collab WHERE status = 'active'")
				.get() as { collab_id: string };
			db.close();
			return row.collab_id;
		})();

		// Simulate a crash/restart that left a NON-NULL but dead pid behind. The
		// resolver treats pid !== null as "live" (it never calls process.kill), so
		// without a daemon-pid probe mount would bind the agent into a dead daemon —
		// the exact silent-hang failure. 2_000_000_000 is a pid that is not running.
		{
			const db = openDatabase(getSharedSqlitePath());
			db.prepare("UPDATE broker_daemon SET pid = 2000000000 WHERE collab_id = ?").run(
				collabIdA,
			);
			db.close();
		}

		const fakeRuntime2 = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime2 as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
			runRecoverFn: stubbedRunRecover,
			isDaemonPidAlive: () => false, // the stale non-null pid is dead
			isPidAlive: () => true,
		});

		// Re-adopted the same collab (no duplicate) and revived the daemon.
		expect(activeCount(workspaceRoot)).toBe(1);
		expect(fakeRuntime2.start).toHaveBeenCalledTimes(1);
		const db = openDatabase(getSharedSqlitePath());
		const live = db
			.prepare("SELECT pid FROM broker_daemon WHERE collab_id = ?")
			.get(collabIdA) as { pid: number | null } | undefined;
		expect(live?.pid).not.toBeNull();
		expect(live?.pid).not.toBe(2000000000); // revived to a fresh pid, not the stale one
		// Agent bound into the re-adopted collab (proves revive-then-bind, not bind-into-dead).
		const binding = db
			.prepare(
				"SELECT collab_id FROM session_binding WHERE collab_id = ? AND agent_type = 'codex'",
			)
			.get(collabIdA) as { collab_id: string } | undefined;
		expect(binding?.collab_id).toBe(collabIdA);
		db.close();
	});

	it("repro-as-test: a collab that owns a running workflow is re-adopted, not duplicated", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "claude",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
		});

		// Bind a running workflow to that collab "A", then kill its daemon.
		const db = openDatabase(getSharedSqlitePath());
		const a = db.prepare("SELECT collab_id FROM collab WHERE status='active'").get() as {
			collab_id: string;
		};
		db.prepare(
			"INSERT INTO workflows (workflow_id, collab_id, workflow_type, spec_path, role_bindings, status, current_phase_index, created_at, updated_at) VALUES ('wfA', ?, 'spec-driven-development', '/spec.md', '{}', 'running', 0, '2026-05-25T00:00:00Z', '2026-05-25T00:00:00Z')",
		).run(a.collab_id);
		db.prepare("UPDATE broker_daemon SET pid = NULL").run();
		db.close();

		const fakeRuntime2 = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "claude",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime2 as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
			runRecoverFn: stubbedRunRecover,
			isPidAlive: () => true,
		});

		const db2 = openDatabase(getSharedSqlitePath());
		const stillActive = db2
			.prepare("SELECT collab_id FROM collab WHERE status='active'")
			.all() as Array<{ collab_id: string }>;
		expect(stillActive).toHaveLength(1);
		expect(stillActive[0]?.collab_id).toBe(a.collab_id); // re-adopted A, no B
		db2.close();
	});

	it("--collab override binds the named collab and takes no cwd-based re-adopt/create path", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const wsA = join(stateRoot, "a");
		const wsB = join(stateRoot, "b");
		mkdirSync(wsA, { recursive: true });
		mkdirSync(wsB, { recursive: true });

		// Two collabs in two workspaces, each with a live (stubbed) daemon.
		for (const ws of [wsA, wsB]) {
			const fakeRuntime = { start: vi.fn(async () => undefined) };
			await runCollabMount({
				workspaceRoot: ws,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: async () => ({ ok: true }) as never,
				runStartFn: stubbedRunStart,
			});
		}
		const collabIdB = (() => {
			const db = openDatabase(getSharedSqlitePath());
			const wsId = workspaceIdFromPath(wsB);
			const row = db
				.prepare(
					"SELECT collab_id FROM collab WHERE workspace_id = ? AND status = 'active'",
				)
				.get(wsId) as { collab_id: string };
			db.close();
			return row.collab_id;
		})();
		const totalBefore = (() => {
			const db = openDatabase(getSharedSqlitePath());
			const n = (
				db.prepare("SELECT COUNT(*) AS n FROM collab").get() as { n: number }
			).n;
			db.close();
			return n;
		})();

		// Mount from workspace A's cwd but with an explicit override to collab B.
		// recover must NOT run and no collab must be created: it must resolve to
		// exactly the named collab B.
		const fakeRuntime = { start: vi.fn(async () => undefined) };
		const runRecover = vi.fn(stubbedRunRecover);
		await runCollabMount({
			workspaceRoot: wsA,
			collabIdOverride: collabIdB,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
			runRecoverFn: runRecover as never,
			isPidAlive: () => true,
		});

		expect(runRecover).not.toHaveBeenCalled(); // override never re-adopts
		const db = openDatabase(getSharedSqlitePath());
		const totalAfter = (
			db.prepare("SELECT COUNT(*) AS n FROM collab").get() as { n: number }
		).n;
		expect(totalAfter).toBe(totalBefore); // no new collab created
		// The attach claim was issued against the named collab B, not A's.
		const claim = db
			.prepare(
				"SELECT collab_id FROM attach_claim WHERE agent_type = 'codex' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { collab_id: string };
		expect(claim.collab_id).toBe(collabIdB);
		db.close();
	});

	it("--collab override with a dead daemon throws instead of recovering or creating", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		const fakeRuntime = { start: vi.fn(async () => undefined) };
		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime: () => fakeRuntime as never,
			assessBroker: async () => ({ ok: true }) as never,
			runStartFn: stubbedRunStart,
		});
		const db = openDatabase(getSharedSqlitePath());
		const collabId = (
			db.prepare("SELECT collab_id FROM collab WHERE status='active'").get() as {
				collab_id: string;
			}
		).collab_id;
		db.prepare("UPDATE broker_daemon SET pid = NULL").run(); // dead daemon
		db.close();

		const runRecover = vi.fn(stubbedRunRecover);
		await expect(
			runCollabMount({
				workspaceRoot,
				collabIdOverride: collabId,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: async () => ({ ok: true }) as never,
				runStartFn: stubbedRunStart,
				runRecoverFn: runRecover as never,
			}),
		).rejects.toThrow(/no live daemon/);
		expect(runRecover).not.toHaveBeenCalled();
	});
});

describe("runCollabMount re-adopt — regression guards", () => {
	let prevStateRoot: string | undefined;
	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		if (prevStateRoot === undefined) delete process.env.AI_WHISPER_STATE_ROOT;
		else process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
	});

	it("a single healthy collab is reused on re-mount — no second active row", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });

		for (let i = 0; i < 2; i++) {
			const fakeRuntime = { start: vi.fn(async () => undefined) };
			await runCollabMount({
				workspaceRoot,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: async () => ({ ok: true }) as never,
				runStartFn: stubbedRunStart,
				isPidAlive: () => false, // no live session owner → reclaim stale binding path
				isDaemonPidAlive: () => true, // the stubbed daemon pid (fake) is healthy → reuse, don't revive
			});
		}

		const db = openDatabase(getSharedSqlitePath());
		const wsId = workspaceIdFromPath(workspaceRoot);
		const n = (
			db
				.prepare("SELECT COUNT(*) AS n FROM collab WHERE workspace_id = ? AND status='active'")
				.get(wsId) as { n: number }
		).n;
		db.close();
		expect(n).toBe(1);
	});

	it("distinct workspaces keep independent active collabs", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const wsA = join(stateRoot, "a");
		const wsB = join(stateRoot, "b");
		mkdirSync(wsA, { recursive: true });
		mkdirSync(wsB, { recursive: true });

		for (const ws of [wsA, wsB]) {
			const fakeRuntime = { start: vi.fn(async () => undefined) };
			await runCollabMount({
				workspaceRoot: ws,
				target: "codex",
				now: new Date().toISOString(),
				resolveCurrentTty: () => "/dev/null",
				createRuntime: () => fakeRuntime as never,
				assessBroker: async () => ({ ok: true }) as never,
				runStartFn: stubbedRunStart,
			});
		}

		const db = openDatabase(getSharedSqlitePath());
		const n = (
			db.prepare("SELECT COUNT(*) AS n FROM collab WHERE status='active'").get() as {
				n: number;
			}
		).n;
		db.close();
		expect(n).toBe(2);
	});
});
