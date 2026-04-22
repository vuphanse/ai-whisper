import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertWorkflowPhaseRun,
	getLatestPhaseRunForIndex,
	listPhaseRunsForWorkflow,
	closeWorkflowPhaseRun,
} from "../packages/broker/src/storage/repositories/workflow-phase-repository.ts";

function setup() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('c1','/tmp','c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	return { db };
}

describe("workflow-phase-repository", () => {
	it("inserts and reads phase runs", () => {
		const { db } = setup();
		insertWorkflowPhaseRun(db, {
			phaseRunId: "wfp_1",
			workflowId: "wf_1",
			phaseIndex: 0,
			phaseName: "spec-refining",
			chainId: "relay_ch_1",
			now: "2026-04-21T00:00:00Z",
		});
		const rec = getLatestPhaseRunForIndex(db, {
			workflowId: "wf_1",
			phaseIndex: 0,
		});
		expect(rec?.phaseRunId).toBe("wfp_1");
		expect(rec?.outcome).toBeNull();
	});

	it("closeWorkflowPhaseRun sets endedAt + outcome", () => {
		const { db } = setup();
		insertWorkflowPhaseRun(db, {
			phaseRunId: "wfp_1",
			workflowId: "wf_1",
			phaseIndex: 0,
			phaseName: "spec-refining",
			chainId: "relay_ch_1",
			now: "2026-04-21T00:00:00Z",
		});
		closeWorkflowPhaseRun(db, {
			phaseRunId: "wfp_1",
			outcome: "done",
			now: "2026-04-21T00:10:00Z",
		});
		const rec = getLatestPhaseRunForIndex(db, { workflowId: "wf_1", phaseIndex: 0 });
		expect(rec?.outcome).toBe("done");
		expect(rec?.endedAt).toBe("2026-04-21T00:10:00Z");
	});

	it("returns latest row for an index when multiple exist (resume path)", () => {
		const { db } = setup();
		insertWorkflowPhaseRun(db, {
			phaseRunId: "wfp_1",
			workflowId: "wf_1",
			phaseIndex: 0,
			phaseName: "spec-refining",
			chainId: "relay_ch_1",
			now: "2026-04-21T00:00:00Z",
		});
		closeWorkflowPhaseRun(db, {
			phaseRunId: "wfp_1",
			outcome: "escalated",
			now: "2026-04-21T00:05:00Z",
		});
		insertWorkflowPhaseRun(db, {
			phaseRunId: "wfp_2",
			workflowId: "wf_1",
			phaseIndex: 0,
			phaseName: "spec-refining",
			chainId: "relay_ch_2",
			now: "2026-04-21T00:10:00Z",
		});
		const rec = getLatestPhaseRunForIndex(db, { workflowId: "wf_1", phaseIndex: 0 });
		expect(rec?.phaseRunId).toBe("wfp_2");
		expect(listPhaseRunsForWorkflow(db, "wf_1")).toHaveLength(2);
	});
});
