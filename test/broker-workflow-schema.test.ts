import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";

describe("workflow schema migrations", () => {
	it("creates workflows, workflow_phases, relay_chains tables", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		const db = broker.db;

		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflows','workflow_phases','relay_chains') ORDER BY name",
			)
			.all() as Array<{ name: string }>;

		expect(tables.map((t) => t.name)).toEqual([
			"relay_chains",
			"workflow_phases",
			"workflows",
		]);
	});

	it("enforces partial unique index: one running workflow per collab", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		const db = broker.db;

		db.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
			 VALUES ('c1', '/tmp', 'c1', 'active', '2026-04-21T00:00:00Z', '2026-04-21T00:00:00Z')`,
		).run();
		db.prepare(
			`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
			 VALUES ('wf_1', 'c1', 't', NULL, '/s', '{}', 'running', 0, NULL, '{}', '2026-04-21T00:00:00Z', '2026-04-21T00:00:00Z')`,
		).run();

		expect(() =>
			db.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path, role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES ('wf_2', 'c1', 't', NULL, '/s', '{}', 'running', 0, NULL, '{}', '2026-04-21T00:00:00Z', '2026-04-21T00:00:00Z')`,
			).run(),
		).toThrow(/UNIQUE/);
	});

	it("widened unique index forbids a second active workflow when one is paused, and is idempotent", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		const db = broker.db;
		const now = "2026-05-27T00:00:00Z";
		db.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
			 VALUES ('c1', '/tmp', 'c1', 'active', ?, ?)`,
		).run(now, now);
		const ins = (id: string, status: string) =>
			db.prepare(
				`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path,
				 role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
				 VALUES (?, 'c1', 'spec-driven-development', NULL, 's.md', '{}', ?, 0, NULL, '{}', ?, ?)`,
			).run(id, status, now, now);

		ins("wf_paused", "paused");
		expect(() => ins("wf_running", "running")).toThrow(/UNIQUE/i);

		// Idempotent re-run must not throw even though a paused workflow already exists.
		expect(() => applyMigrations(db)).not.toThrow();
		// A done workflow does NOT occupy the slot.
		ins("wf_done", "done");
		expect(db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE collab_id='c1'").get()).toEqual({ n: 2 });
	});

	it("adds evaluator bookkeeping columns to relay_handoff", () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		const db = broker.db;
		const cols = db
			.prepare("PRAGMA table_info(relay_handoff)")
			.all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);
		for (const expected of [
			"handoff_step",
			"workflow_id",
			"phase_run_id",
			"evaluator_verdict",
			"evaluator_confidence",
			"evaluator_reason",
			"evaluator_evaluated_at",
		]) {
			expect(names, `missing column ${expected}`).toContain(expected);
		}
	});
});
