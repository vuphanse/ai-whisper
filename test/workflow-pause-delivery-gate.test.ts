import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function makeRuntime() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-gate-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "broker.sqlite"),
		host: "127.0.0.1",
		port: 4399,
	});
}

const NOW = "2026-05-27T00:00:00Z";

function seedCollab(broker: ReturnType<typeof makeRuntime>, collabId: string) {
	broker.control.startCollab({
		collabId,
		workspaceRoot: "/tmp",
		displayName: collabId,
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: NOW,
	});
}

function seedWorkflow(
	broker: ReturnType<typeof makeRuntime>,
	workflowId: string,
	collabId: string,
	status: string,
) {
	broker.db
		.prepare(
			`INSERT INTO workflows (workflow_id, collab_id, workflow_type, name, spec_path,
			 role_bindings, status, current_phase_index, halt_reason, workflow_context, created_at, updated_at)
			 VALUES (?, ?, 'spec-driven-development', NULL, 's.md', '{}', ?, 0, NULL, '{}', ?, ?)`,
		)
		.run(workflowId, collabId, status, NOW, NOW);
}

function seedHandoff(
	broker: ReturnType<typeof makeRuntime>,
	handoffId: string,
	collabId: string,
	opts: { status: string; workflowId: string | null; orchestratorStatus?: string },
) {
	broker.db
		.prepare(
			`INSERT INTO relay_handoff (handoff_id, collab_id, sender_agent, target_agent, request_text,
			 status, created_at, last_activity_at, orchestrator_status, workflow_id)
			 VALUES (?, ?, 'claude', 'codex', 'do work', ?, ?, ?, ?, ?)`,
		)
		.run(
			handoffId,
			collabId,
			opts.status,
			NOW,
			NOW,
			opts.orchestratorStatus ?? "idle",
			opts.workflowId,
		);
}

describe("workflow pause delivery gate", () => {
	it("isWorkflowDeliverySuspended: true for paused-workflow handoff, false for running and legacy", () => {
		const broker = makeRuntime();
		seedCollab(broker, "collab_c1");
		seedCollab(broker, "collab_c2");
		seedWorkflow(broker, "wf_run", "collab_c1", "running");
		seedWorkflow(broker, "wf_pause", "collab_c2", "paused");
		seedHandoff(broker, "ho_running", "collab_c1", { status: "handed_back", workflowId: "wf_run" });
		seedHandoff(broker, "ho_paused", "collab_c2", { status: "handed_back", workflowId: "wf_pause" });
		seedHandoff(broker, "ho_legacy", "collab_c1", { status: "handed_back", workflowId: null });

		expect(broker.control.isWorkflowDeliverySuspended("ho_paused")).toBe(true);
		expect(broker.control.isWorkflowDeliverySuspended("ho_running")).toBe(false);
		expect(broker.control.isWorkflowDeliverySuspended("ho_legacy")).toBe(false);
		expect(broker.control.isWorkflowDeliverySuspended("ho_missing")).toBe(false);
	});

	it("listRelayHandoffsPendingOrchestration excludes paused-workflow handoffs, keeps running + legacy", () => {
		const broker = makeRuntime();
		seedCollab(broker, "collab_c1");
		seedCollab(broker, "collab_c2");
		seedWorkflow(broker, "wf_run", "collab_c1", "running");
		seedWorkflow(broker, "wf_pause", "collab_c2", "paused");
		seedHandoff(broker, "ho_running", "collab_c1", { status: "handed_back", workflowId: "wf_run" });
		seedHandoff(broker, "ho_legacy", "collab_c1", { status: "handed_back", workflowId: null });
		seedHandoff(broker, "ho_paused", "collab_c2", { status: "handed_back", workflowId: "wf_pause" });

		const c1 = broker.control.listRelayHandoffsPendingOrchestration("collab_c1").map((h) => h.handoffId);
		expect(c1).toContain("ho_running");
		expect(c1).toContain("ho_legacy");

		const c2 = broker.control.listRelayHandoffsPendingOrchestration("collab_c2").map((h) => h.handoffId);
		expect(c2).not.toContain("ho_paused");
	});
});
