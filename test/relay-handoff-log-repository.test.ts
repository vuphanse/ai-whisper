import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listRelayHandoffs } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "rh-log-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function insertHandoff(
	db: ReturnType<typeof freshDb>,
	h: {
		id: string;
		collab: string;
		createdAt: string;
		workflowId?: string | null;
		phaseRunId?: string | null;
		round?: number | null;
		step?: string | null;
		verdict?: string | null;
		confidence?: number | null;
		reason?: string | null;
		capture?: string | null;
	},
) {
	// NOTE: relay_handoff has NO max_rounds column — RelayHandoffRecord.maxRounds
	// is derived via JOIN collab c (c.orchestrator_max_rounds). Do not insert it.
	db.prepare(
		`INSERT INTO relay_handoff
		 (handoff_id,collab_id,sender_agent,target_agent,request_text,status,
		  created_at,last_activity_at,capture_status,chain_id,round_number,
		  handback_text,workflow_id,phase_run_id,handoff_step,
		  evaluator_verdict,evaluator_confidence,evaluator_reason)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		h.id, h.collab, "codex", "claude", "req", "handed_back",
		h.createdAt, h.createdAt, h.capture ?? null, "chain_1",
		h.round ?? null, "did the thing", h.workflowId ?? null,
		h.phaseRunId ?? null, h.step ?? null, h.verdict ?? null,
		h.confidence ?? null, h.reason ?? null,
	);
}

describe("listRelayHandoffs", () => {
	it("returns collab handoffs ordered by (created_at, handoff_id), workflow + manual", () => {
		const db = freshDb();
		insertHandoff(db, { id: "h2", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z" });
		insertHandoff(db, {
			id: "h1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z",
			workflowId: "wf1", phaseRunId: "pr1", round: 2, step: "fix",
			verdict: "approve", confidence: 0.95, reason: "ok", capture: "ok",
		});
		insertHandoff(db, { id: "other", collab: "c2", createdAt: "2026-05-19T00:00:00.000Z" });

		const rows = listRelayHandoffs(db, { collabId: "c1" });

		expect(rows.map((r) => r.handoffId)).toEqual(["h1", "h2"]);
		expect(rows[0]).toMatchObject({
			handoffId: "h1", workflowId: "wf1", phaseRunId: "pr1",
			roundNumber: 2, handoffStep: "fix", evaluatorVerdict: "approve",
			evaluatorConfidence: 0.95, evaluatorReason: "ok", captureStatus: "ok",
			senderAgent: "codex", targetAgent: "claude", status: "handed_back",
		});
		expect(rows[1]).toMatchObject({
			handoffId: "h2", workflowId: null, phaseRunId: null,
			roundNumber: null, handoffStep: null, evaluatorVerdict: null,
		});
	});

	it("paginates with the (createdAt, handoffId) cursor incl. same-timestamp tie-break", () => {
		const db = freshDb();
		insertHandoff(db, { id: "a", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z" });
		insertHandoff(db, { id: "b", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z" });
		insertHandoff(db, { id: "c", collab: "c1", createdAt: "2026-05-19T00:00:02.000Z" });

		const first = listRelayHandoffs(db, { collabId: "c1" });
		expect(first.map((r) => r.handoffId)).toEqual(["a", "b", "c"]);

		const after = { createdAt: first[1]!.createdAt, handoffId: first[1]!.handoffId };
		const page2 = listRelayHandoffs(db, { collabId: "c1", afterCursor: after });
		expect(page2.map((r) => r.handoffId)).toEqual(["c"]);
	});

	it("returns [] for an unknown collab", () => {
		const db = freshDb();
		expect(listRelayHandoffs(db, { collabId: "nope" })).toEqual([]);
	});
});

describe("control.listRelayHandoffs", () => {
	it("is exposed on broker.control and is collab-scoped", () => {
		const dir = mkdtempSync(join(tmpdir(), "rh-ctl-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(dir, "state.db"),
			host: "127.0.0.1",
			port: 4733,
		});
		try {
			insertHandoff(broker.db, {
				id: "h1", collab: "c1", createdAt: "2026-05-19T00:00:01.000Z",
				workflowId: "wf1", round: 1, step: "review", verdict: "approve",
			});
			const rows = broker.control.listRelayHandoffs("c1");
			expect(rows.map((r) => r.handoffId)).toEqual(["h1"]);
			expect(rows[0]?.evaluatorVerdict).toBe("approve");
		} finally {
			void broker.stop();
		}
	});
});
