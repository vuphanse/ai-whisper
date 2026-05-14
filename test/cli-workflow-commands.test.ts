import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runWorkflowStart } from "../packages/cli/src/commands/workflow/start.ts";
import { runWorkflowList } from "../packages/cli/src/commands/workflow/list.ts";
import { runWorkflowResume } from "../packages/cli/src/commands/workflow/resume.ts";
import { runWorkflowCancel } from "../packages/cli/src/commands/workflow/cancel.ts";
import { runWorkflowTypes } from "../packages/cli/src/commands/workflow/types.ts";

function boot() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: "collab_c1",
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: "2026-04-21T00:00:00Z",
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: "collab_c1",
			agentType: agent,
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	return broker;
}

describe("whisper workflow commands", () => {
	it("start creates a workflow and returns the ID", async () => {
		const broker = boot();
		const result = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "superpowers-feature-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		expect(result.workflowId).toMatch(/^wf_/);
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("list returns running workflows", async () => {
		const broker = boot();
		await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "superpowers-feature-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		const list = await runWorkflowList({ broker, collabId: "collab_c1" });
		expect(list).toHaveLength(1);
		await new Promise((r) => setImmediate(r));
		await broker.stop();
	});

	it("types enumerates registry", async () => {
		const types = await runWorkflowTypes();
		expect(types).toContain("superpowers-feature-development");
	});

	it("cancel + resume rejects", async () => {
		const broker = boot();
		const { workflowId } = await runWorkflowStart({
			broker,
			collabId: "collab_c1",
			workflowType: "superpowers-feature-development",
			specPath: "docs/spec.md",
			implementer: "claude",
			reviewer: "codex",
			now: "2026-04-21T00:00:00Z",
		});
		await new Promise((r) => setImmediate(r));
		await runWorkflowCancel({ broker, workflowId, now: "2026-04-21T00:00:01Z" });
		await expect(
			runWorkflowResume({ broker, workflowId, now: "2026-04-21T00:00:02Z" }),
		).rejects.toThrow(/canceled/);
		await broker.stop();
	});
});
