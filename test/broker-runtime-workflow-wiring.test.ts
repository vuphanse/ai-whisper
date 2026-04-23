import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("broker runtime wires WorkflowDriver", () => {
	it("creating a workflow triggers phase-0 kickoff without explicit driver start", async () => {
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4321,
		});
		try {
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
					sessionId: agent === "claude" ? "session_claude" : "session_codex",
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}
			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_c1",
				workflowType: "superpowers-feature-development",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});
			await new Promise((r) => setImmediate(r));
			expect(broker.control.getWorkflowPhaseRuns(workflowId)).toHaveLength(1);
		} finally {
			await broker.stop();
		}
	});
});
