import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-wfdef-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "x.sqlite"),
		host: "127.0.0.1",
		port: 4730,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

function seedCollab(broker: ReturnType<typeof newBroker>) {
	const now = new Date().toISOString();
	// orchestrator_enabled MUST be 1 — workflow-control.ts:94 rejects
	// orchestrator-disabled collabs before resolving role bindings.
	broker.control.startCollab({
		collabId: "collab_x",
		workspaceRoot: "/tmp/x",
		displayName: "x",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 5,
		now,
	});
	// workflow-control.ts:105 then verifies each role's agent has a BOUND
	// session binding. Seed both so SDD's defaults (implementer=claude,
	// reviewer=codex) resolve cleanly.
	for (const agent of ["codex", "claude"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_x",
			agentType: agent,
			sessionId: `session_${agent}_x`,
			bindingSource: "adopted",
			now,
		});
	}
}

describe("runWorkflowStart default role resolution", () => {
	it("fills implementer/reviewer from the SDD type's defaults when omitted", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			const result = await runWorkflowStart({
				broker,
				collabId: "collab_x",
				workflowType: "spec-driven-development",
				specPath: "/tmp/spec.md",
				// no implementer / reviewer
				now: new Date().toISOString(),
			});
			expect(result.workflowId).toMatch(/^wf_/);
			// Verify the workflow row carries the resolved defaults.
			const wf = broker.control.getWorkflow(result.workflowId);
			expect(wf?.workflowType).toBe("spec-driven-development");
			const bindings = JSON.parse(
				(broker.db
					.prepare("SELECT role_bindings FROM workflows WHERE workflow_id = ?")
					.get(result.workflowId) as { role_bindings: string }).role_bindings,
			);
			expect(bindings).toMatchObject({
				implementer: "claude",
				reviewer: "codex",
			});
		} finally {
			await broker.stop();
		}
	});

	it("explicit flags override the type defaults", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			const result = await runWorkflowStart({
				broker,
				collabId: "collab_x",
				workflowType: "spec-driven-development",
				specPath: "/tmp/spec.md",
				implementer: "codex",
				reviewer: "claude",
				now: new Date().toISOString(),
			});
			const bindings = JSON.parse(
				(broker.db
					.prepare("SELECT role_bindings FROM workflows WHERE workflow_id = ?")
					.get(result.workflowId) as { role_bindings: string }).role_bindings,
			);
			expect(bindings).toMatchObject({
				implementer: "codex",
				reviewer: "claude",
			});
		} finally {
			await broker.stop();
		}
	});

	it("a workflow type without defaults errors clearly when flags are omitted", async () => {
		const broker = newBroker();
		try {
			seedCollab(broker);
			await expect(
				runWorkflowStart({
					broker,
					collabId: "collab_x",
					workflowType: "fake-no-defaults-type" as never,
					specPath: "/tmp/spec.md",
					now: new Date().toISOString(),
				}),
			).rejects.toThrow(/implementer.*reviewer|defaults/i);
		} finally {
			await broker.stop();
		}
	});
});
