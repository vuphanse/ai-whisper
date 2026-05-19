import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	listActiveCollabSummaries,
} from "../packages/broker/src/storage/repositories/dashboard-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-dash-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function insCollab(db: ReturnType<typeof freshDb>, id: string, name = id) {
	db.prepare(
		`INSERT INTO collab (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
		 VALUES (?,?,?,'active','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z',0,3)`,
	).run(id, `/tmp/${id}`, name);
}
function insWorkflow(db: ReturnType<typeof freshDb>, w: { id: string; collab: string; type?: string; name?: string | null; status?: string; phaseIdx?: number; createdAt?: string }) {
	db.prepare(
		`INSERT INTO workflows (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,current_phase_index,halt_reason,workflow_context,created_at,updated_at)
		 VALUES (?,?,?,?, '/s', '{}', ?, ?, NULL, '{}', ?, ?)`,
	).run(w.id, w.collab, w.type ?? "spec-driven-development", w.name ?? null, w.status ?? "running", w.phaseIdx ?? 1, w.createdAt ?? "2026-05-20T00:01:00.000Z", w.createdAt ?? "2026-05-20T00:01:00.000Z");
}
function insPhase(db: ReturnType<typeof freshDb>, p: { id: string; wf: string; idx: number; name: string; chain: string; started: string; ended?: string | null; outcome?: string | null }) {
	db.prepare(
		`INSERT INTO workflow_phases (phase_run_id,workflow_id,phase_index,phase_name,chain_id,started_at,ended_at,outcome)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(p.id, p.wf, p.idx, p.name, p.chain, p.started, p.ended ?? null, p.outcome ?? null);
}
function insChain(db: ReturnType<typeof freshDb>, c: { id: string; collab: string; status?: string; round?: number; max?: number }) {
	db.prepare(
		`INSERT INTO relay_chains (chain_id,collab_id,status,current_round,max_rounds,terminal_handoff_id,terminal_reason,created_at,updated_at)
		 VALUES (?,?,?,?,?,NULL,NULL,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z')`,
	).run(c.id, c.collab, c.status ?? "active", c.round ?? 1, c.max ?? 5);
}
function insHandoff(db: ReturnType<typeof freshDb>, h: { id: string; collab: string; wf?: string | null; phase?: string | null; chain?: string | null; createdAt: string; lastAct?: string; status?: string }) {
	db.prepare(
		`INSERT INTO relay_handoff (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,last_activity_at,workflow_id,phase_run_id,chain_id)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
	).run(h.id, h.collab, "codex", "claude", "req", h.status ?? "handed_back", h.createdAt, h.lastAct ?? h.createdAt, h.wf ?? null, h.phase ?? null, h.chain ?? null);
}

describe("listActiveCollabSummaries", () => {
	const NOW = "2026-05-20T01:00:00.000Z";
	const sinceMs = 30 * 60_000;

	it("resolves a running workflow run, recency-filters, and labels", () => {
		const db = freshDb();
		insCollab(db, "c_run", "Runner");
		insWorkflow(db, { id: "wf1", collab: "c_run", name: "oauth", phaseIdx: 1 });
		insChain(db, { id: "ch1", collab: "c_run", status: "active", round: 3, max: 5 });
		insPhase(db, { id: "pr1", wf: "wf1", idx: 1, name: "plan-writing", chain: "ch1", started: "2026-05-20T00:50:00.000Z", ended: null });
		insHandoff(db, { id: "h1", collab: "c_run", wf: "wf1", phase: "pr1", chain: "ch1", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:59:30.000Z" });
		insCollab(db, "c_old");
		insHandoff(db, { id: "hx", collab: "c_old", createdAt: "2026-05-19T23:00:00.000Z", lastAct: "2026-05-19T23:00:00.000Z" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows.map((r) => r.collabId)).toEqual(["c_run"]);
		expect(rows[0]).toMatchObject({
			collabId: "c_run", label: "oauth", workflowId: "wf1",
			workflowType: "spec-driven-development", workflowStatus: "running",
			currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
			currentRound: 3, maxRounds: 5, chainStatus: "active",
			lastActivityAt: "2026-05-20T00:59:30.000Z",
		});
	});

	it("manual-relay collab (no workflow) appears with null workflow fields", () => {
		const db = freshDb();
		insCollab(db, "c_man", "Manual");
		insHandoff(db, { id: "h1", collab: "c_man", createdAt: "2026-05-20T00:58:00.000Z", lastAct: "2026-05-20T00:58:00.000Z" });
		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]).toMatchObject({
			collabId: "c_man", label: "Manual", workflowId: null, workflowType: null,
			workflowStatus: null, currentPhaseRunId: null, chainStatus: null,
		});
	});

	it("picks the running workflow over an older terminal one", () => {
		const db = freshDb();
		insCollab(db, "c2");
		insWorkflow(db, { id: "old", collab: "c2", status: "done", createdAt: "2026-05-20T00:00:30.000Z" });
		insWorkflow(db, { id: "new", collab: "c2", status: "running", createdAt: "2026-05-20T00:40:00.000Z" });
		insHandoff(db, { id: "h", collab: "c2", wf: "new", createdAt: "2026-05-20T00:50:00.000Z", lastAct: "2026-05-20T00:59:00.000Z" });
		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		expect(rows[0]?.workflowId).toBe("new");
		expect(rows[0]?.workflowStatus).toBe("running");
	});

	it("REGRESSION: re-read reflects an in-place status mutation (no cursor staleness)", () => {
		const db = freshDb();
		insCollab(db, "c3");
		insWorkflow(db, { id: "wf", collab: "c3", status: "running" });
		insHandoff(db, { id: "h", collab: "c3", wf: "wf", createdAt: "2026-05-20T00:55:00.000Z", lastAct: "2026-05-20T00:55:00.000Z" });
		expect(listActiveCollabSummaries(db, { sinceMs, now: NOW })[0]?.workflowStatus).toBe("running");
		db.prepare("UPDATE workflows SET status='halted' WHERE workflow_id='wf'").run();
		db.prepare("UPDATE relay_handoff SET last_activity_at='2026-05-20T00:59:50.000Z' WHERE handoff_id='h'").run();
		const after = listActiveCollabSummaries(db, { sinceMs, now: NOW })[0];
		expect(after?.workflowStatus).toBe("halted");
		expect(after?.lastActivityAt).toBe("2026-05-20T00:59:50.000Z");
	});

	it("returns [] when nothing is recently active", () => {
		const db = freshDb();
		expect(listActiveCollabSummaries(db, { sinceMs, now: NOW })).toEqual([]);
	});
});
