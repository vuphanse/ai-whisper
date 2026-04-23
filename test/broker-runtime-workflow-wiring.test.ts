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

	it("does not drive workflows when runWorkflowDriver is false", async () => {
		// Transient CLI brokers (`workflow start`, `workflow list`, etc.) open
		// the shared SQLite purely to issue control calls and then stop.
		// The daemon broker is the authoritative driver; letting the transient
		// broker also subscribe races broker.stop() against setImmediate-
		// scheduled kickoff and crashes on a closed db.
		const broker = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4322,
			runWorkflowDriver: false,
		});
		try {
			broker.control.startCollab({
				collabId: "collab_c2",
				workspaceRoot: "/tmp",
				displayName: "c2",
				orchestratorEnabled: true,
				orchestratorMaxRounds: 3,
				now: "2026-04-21T00:00:00Z",
			});
			for (const agent of ["claude", "codex"] as const) {
				broker.control.setSessionBinding({
					collabId: "collab_c2",
					agentType: agent,
					sessionId: agent === "claude" ? "session_claude_2" : "session_codex_2",
					bindingSource: "adopted",
					now: "2026-04-21T00:00:00Z",
				});
			}
			const { workflowId } = broker.control.createWorkflow({
				collabId: "collab_c2",
				workflowType: "superpowers-feature-development",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-04-21T00:00:00Z",
			});
			await new Promise((r) => setImmediate(r));
			// Driver disabled → no phase run inserted; daemon (another process)
			// will pick the workflow up via its 30s recovery sweep.
			expect(broker.control.getWorkflowPhaseRuns(workflowId)).toHaveLength(0);
		} finally {
			// Must not crash even after createWorkflow emitted workflow.created.
			await broker.stop();
		}
	});
});
