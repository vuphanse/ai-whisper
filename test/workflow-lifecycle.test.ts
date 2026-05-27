import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function setup() {
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
			sessionId: agent === "claude" ? "session_claude" : "session_codex",
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	const { workflowId } = broker.control.createWorkflow({
		collabId: "collab_c1",
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now: "2026-04-21T00:00:00Z",
	});
	return { broker, workflowId };
}

// helper for tests that need an active phase run
function setupWithPhase() {
	const { broker, workflowId } = setup();
	const { handoffId, chainId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "spec-refining",
		initialHandoffStep: "review",
		kickoffText: "Review the spec at docs/spec.md.",
		sender: "claude",
		target: "codex",
		maxRounds: 3,
		now: "2026-04-21T00:01:00Z",
	});
	return { broker, workflowId, handoffId, chainId };
}

describe("workflow lifecycle (halt/resume/cancel)", () => {
	it("haltWorkflow transitions running → halted and emits workflow.halted", () => {
		const { broker, workflowId } = setup();
		const halted: unknown[] = [];
		broker.events.on("workflow.halted", (e) => halted.push(e));
		broker.control.haltWorkflow({
			workflowId,
			reason: "target agent missing",
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
		expect(halted).toEqual([{ workflowId, reason: "target agent missing" }]);
	});

	it("resumeWorkflow rejects canceled status", () => {
		const { broker, workflowId } = setup();
		broker.control.cancelWorkflow({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(() =>
			broker.control.resumeWorkflow({
				workflowId,
				now: "2026-04-21T00:06:00Z",
			}),
		).toThrow(/canceled/);
	});

	it("resumeWorkflow rejects when another workflow is already running", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "stuck",
			now: "2026-04-21T00:05:00Z",
		});
		// Start a second, now-running workflow
		broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec2.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:06:00Z",
		});
		expect(() =>
			broker.control.resumeWorkflow({
				workflowId,
				now: "2026-04-21T00:07:00Z",
			}),
		).toThrow(/already (running|active)/);
	});

	it("createWorkflow rejects a second workflow while the first is paused (active-set guard)", () => {
		const { broker, workflowId } = setup();
		// Flip the existing workflow to paused directly (pauseWorkflow lands in a later task);
		// the active-set guard must still count it as occupying the collab slot.
		broker.db
			.prepare("UPDATE workflows SET status = 'paused' WHERE workflow_id = ?")
			.run(workflowId);
		expect(() =>
			broker.control.createWorkflow({
				collabId: "collab_c1",
				workflowType: "spec-driven-development",
				specPath: "docs/spec2.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: "2026-05-27T00:03:00Z",
			}),
		).toThrow(/already active/);
	});

	it("resumeWorkflow flips halted → running and emits workflow.resumed", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "stuck",
			now: "2026-04-21T00:05:00Z",
		});
		const resumed: unknown[] = [];
		broker.events.on("workflow.resumed", (e) => resumed.push(e));
		broker.control.resumeWorkflow({
			workflowId,
			now: "2026-04-21T00:06:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("running");
		expect(resumed).toEqual([{ workflowId, phaseIndex: 0 }]);
	});

	it("cancelWorkflow sets status=canceled, closes open phase run, abandons chain, and emits workflow.canceled", () => {
		const { broker, workflowId, chainId } = setupWithPhase();
		const phaseRuns = broker.control.getWorkflowPhaseRuns(workflowId);
		const openRun = phaseRuns.find((r) => r.endedAt === null);
		expect(openRun).toBeDefined();
		const canceled: unknown[] = [];
		broker.events.on("workflow.canceled", (e) => canceled.push(e));
		broker.control.cancelWorkflow({
			workflowId,
			now: "2026-04-21T00:05:00Z",
		});
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("canceled");
		const after = broker.control.getWorkflowPhaseRuns(workflowId).find((r) => r.phaseRunId === openRun!.phaseRunId);
		expect(after?.endedAt).toBe("2026-04-21T00:05:00Z");
		expect(after?.outcome).toBe("superseded");
		expect(broker.control.getRelayChain(chainId)?.status).toBe("abandoned");
		expect(canceled).toEqual([
			{ workflowId, reason: "canceled by operator" },
		]);
		// Turn state must idle so mount panes stop advertising the abandoned handoff.
		const turnState = broker.control.getRelayTurnState("collab_c1");
		expect(turnState?.unresolvedHandoffId).toBeNull();
		expect(turnState?.turnOwner).toBe("none");
		expect(turnState?.waitingAgent).toBeNull();
		expect(turnState?.handoffState).toBe("idle");
		expect(turnState?.chainStatus).toBe("abandoned");
	});

	it("haltWorkflow throws when workflow not found", () => {
		const { broker } = setup();
		expect(() =>
			broker.control.haltWorkflow({
				workflowId: "wf_nonexistent",
				reason: "gone",
				now: "2026-04-21T00:05:00Z",
			}),
		).toThrow();
	});

	it("haltWorkflow throws when workflow already halted", () => {
		const { broker, workflowId } = setup();
		broker.control.haltWorkflow({
			workflowId,
			reason: "first halt",
			now: "2026-04-21T00:05:00Z",
		});
		expect(() =>
			broker.control.haltWorkflow({
				workflowId,
				reason: "second halt",
				now: "2026-04-21T00:06:00Z",
			}),
		).toThrow();
	});
});
