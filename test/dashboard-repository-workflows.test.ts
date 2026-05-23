import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listWorkflowsForCollab } from "../packages/broker/src/storage/repositories/dashboard-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-wf-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function insCollab(db: ReturnType<typeof freshDb>, id: string) {
	db.prepare(
		`INSERT INTO collab (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
		 VALUES (?,?,?,'active','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z',0,3)`,
	).run(id, `/tmp/${id}`, id);
}

function insWorkflow(
	db: ReturnType<typeof freshDb>,
	w: { id: string; collab: string; type?: string; name?: string | null; status?: string; phaseIdx?: number; createdAt: string },
) {
	db.prepare(
		`INSERT INTO workflows (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,current_phase_index,halt_reason,workflow_context,created_at,updated_at)
		 VALUES (?,?,?,?, '/s', '{}', ?, ?, NULL, '{}', ?, ?)`,
	).run(w.id, w.collab, w.type ?? "spec-driven-development", w.name ?? null, w.status ?? "done", w.phaseIdx ?? 0, w.createdAt, w.createdAt);
}

describe("listWorkflowsForCollab (Bug B)", () => {
	it("returns all workflows newest-first with the expected shape", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insWorkflow(db, { id: "wf_old", collab: "c1", name: "first", status: "done", phaseIdx: 2, createdAt: "2026-05-20T00:00:00.000Z" });
		insWorkflow(db, { id: "wf_mid", collab: "c1", name: "second", status: "halted", phaseIdx: 1, createdAt: "2026-05-20T00:30:00.000Z" });
		insWorkflow(db, { id: "wf_new", collab: "c1", name: "third", status: "running", phaseIdx: 0, createdAt: "2026-05-20T01:00:00.000Z" });
		// another collab's workflow must not leak
		insCollab(db, "c2");
		insWorkflow(db, { id: "wf_other", collab: "c2", createdAt: "2026-05-20T02:00:00.000Z" });

		const rows = listWorkflowsForCollab(db, "c1");
		expect(rows.map((r) => r.workflowId)).toEqual(["wf_new", "wf_mid", "wf_old"]);
		expect(rows[0]).toEqual({
			workflowId: "wf_new",
			workflowType: "spec-driven-development",
			name: "third",
			status: "running",
			currentPhaseIndex: 0,
			createdAt: "2026-05-20T01:00:00.000Z",
		});
	});

	it("returns [] for a collab with no workflows", () => {
		const db = freshDb();
		insCollab(db, "empty");
		expect(listWorkflowsForCollab(db, "empty")).toEqual([]);
	});
});
