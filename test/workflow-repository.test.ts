import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertWorkflow,
	getWorkflowById,
	listWorkflows,
	setWorkflowStatus,
	updateWorkflowContext,
	incrementCurrentPhaseIndex,
	countActiveWorkflowsForCollab,
} from "../packages/broker/src/storage/repositories/workflow-repository.ts";

function bootstrap() {
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
	return { broker, db };
}

describe("workflow-repository", () => {
	it("inserts and reads a workflow", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "spec-driven-development",
			name: "feature x",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		const rec = getWorkflowById(db, "wf_1");
		expect(rec?.status).toBe("running");
		expect(rec?.roleBindings).toEqual({ implementer: "claude", reviewer: "codex" });
		expect(rec?.workflowContext).toEqual({});
	});

	it("lists workflows filtered by status", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		expect(listWorkflows(db, { status: "running" })).toHaveLength(1);
		expect(listWorkflows(db, { status: "done" })).toHaveLength(0);
	});

	it("setWorkflowStatus can flip running→halted with reason", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		setWorkflowStatus(db, {
			workflowId: "wf_1",
			status: "halted",
			haltReason: "agent missing",
			now: "2026-04-21T00:01:00Z",
		});
		expect(getWorkflowById(db, "wf_1")?.status).toBe("halted");
		expect(getWorkflowById(db, "wf_1")?.haltReason).toBe("agent missing");
	});

	it("updateWorkflowContext merges JSON keys", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: { a: 1 },
			now: "2026-04-21T00:00:00Z",
		});
		updateWorkflowContext(db, {
			workflowId: "wf_1",
			patch: { baseBeforeExecution: "abc123" },
			now: "2026-04-21T00:00:01Z",
		});
		expect(getWorkflowById(db, "wf_1")?.workflowContext).toEqual({
			a: 1,
			baseBeforeExecution: "abc123",
		});
	});

	it("incrementCurrentPhaseIndex moves pointer forward", () => {
		const { db } = bootstrap();
		insertWorkflow(db, {
			workflowId: "wf_1",
			collabId: "c1",
			workflowType: "t",
			name: null,
			specPath: "/s",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running",
			currentPhaseIndex: 0,
			workflowContext: {},
			now: "2026-04-21T00:00:00Z",
		});
		incrementCurrentPhaseIndex(db, { workflowId: "wf_1", now: "2026-04-21T00:01:00Z" });
		expect(getWorkflowById(db, "wf_1")?.currentPhaseIndex).toBe(1);
	});

	it("countActiveWorkflowsForCollab counts both running and paused", () => {
		const { db } = bootstrap();
		db.prepare(
			`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
			 VALUES ('c2','/tmp','c2','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
		).run();
		const now = "2026-05-27T00:00:00Z";
		insertWorkflow(db, {
			workflowId: "wf_run", collabId: "c1", workflowType: "spec-driven-development",
			name: null, specPath: "s.md", roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "running", currentPhaseIndex: 0, workflowContext: {}, now,
		});
		insertWorkflow(db, {
			workflowId: "wf_pause", collabId: "c2", workflowType: "spec-driven-development",
			name: null, specPath: "s.md", roleBindings: { implementer: "claude", reviewer: "codex" },
			status: "paused", currentPhaseIndex: 0, workflowContext: {}, now,
		});
		expect(countActiveWorkflowsForCollab(db, "c1")).toBe(1);
		expect(countActiveWorkflowsForCollab(db, "c2")).toBe(1);
		expect(countActiveWorkflowsForCollab(db, "c3")).toBe(0);
	});
});
