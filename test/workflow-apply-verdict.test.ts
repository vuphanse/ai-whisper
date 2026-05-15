import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

const COLLAB_ID = "collab_c1";

function setup() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	broker.control.startCollab({
		collabId: COLLAB_ID,
		workspaceRoot: "/tmp",
		displayName: "c1",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 3,
		now: "2026-04-21T00:00:00Z",
	});
	for (const agent of ["claude", "codex"] as const) {
		broker.control.setSessionBinding({
			collabId: COLLAB_ID,
			agentType: agent,
			sessionId: `session_${agent}`,
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	const { workflowId } = broker.control.createWorkflow({
		collabId: COLLAB_ID,
		workflowType: "spec-driven-development",
		specPath: "docs/spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now: "2026-04-21T00:00:00Z",
	});
	const { handoffId, chainId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "spec-refining",
		initialHandoffStep: "review",
		kickoffText: "Review the spec at docs/spec.md.",
		sender: "claude",
		target: "codex",
		maxRounds: 5,
		now: "2026-04-21T00:01:00Z",
	});
	return { broker, workflowId, handoffId, chainId };
}

/**
 * Drive a workflow from phase 0 (spec-refining) all the way to the plan-execution
 * execute handoff, returning the handoffId for that execute step.
 */
function driveToExecutePhase(
	broker: ReturnType<typeof setup>["broker"],
	workflowId: string,
	specRefineHandoffId: string,
): { executeHandoffId: string; chainId: string } {
	// Phase 0: spec-refining approve → advances to plan-writing (implement step)
	broker.control.applyOrchestratorVerdict({
		handoffId: specRefineHandoffId,
		verdict: "approve",
		confidence: 0.9,
		reason: "spec good",
		now: "2026-04-21T00:10:00Z",
	});

	// Phase 1: plan-writing — get the implement handoff
	const planImplementRow = broker.db
		.prepare(
			"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'implement' ORDER BY created_at DESC LIMIT 1",
		)
		.get(workflowId) as { handoff_id: string };

	// delivered → creates review handoff
	broker.control.applyOrchestratorVerdict({
		handoffId: planImplementRow.handoff_id,
		verdict: "delivered",
		confidence: 0.9,
		reason: "plan written",
		now: "2026-04-21T00:11:00Z",
	});

	// plan-writing review → approve with workspaceHeadSha → advances to plan-execution
	const planReviewRow = broker.db
		.prepare(
			"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' AND phase_run_id IN (SELECT phase_run_id FROM workflow_phases WHERE phase_index = 1) ORDER BY created_at DESC LIMIT 1",
		)
		.get(workflowId) as { handoff_id: string };

	broker.control.applyOrchestratorVerdict({
		handoffId: planReviewRow.handoff_id,
		verdict: "approve",
		confidence: 0.9,
		reason: "plan good",
		workspaceHeadSha: "abc1234",
		now: "2026-04-21T00:12:00Z",
	});

	// plan-execution execute handoff
	const executeRow = broker.db
		.prepare(
			"SELECT handoff_id, chain_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'execute' ORDER BY created_at DESC LIMIT 1",
		)
		.get(workflowId) as { handoff_id: string; chain_id: string };

	return { executeHandoffId: executeRow.handoff_id, chainId: executeRow.chain_id };
}

describe("applyOrchestratorVerdict — review step", () => {
	it("review + approve → chain done, phase advanced, next phase started", () => {
		const { broker, workflowId, handoffId } = setup();
		const seen: string[] = [];
		for (const name of [
			"chain.resolved",
			"workflow.phase-done",
			"workflow.phase-started",
			"workflow.round-started",
		] as const) {
			broker.events.on(name, () => seen.push(name));
		}

		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "approve",
			confidence: 0.9,
			reason: "spec is clear",
			now: "2026-04-21T00:10:00Z",
		});

		expect(result.action).toBe("phase-advanced");
		expect(seen).toEqual([
			"chain.resolved",
			"workflow.phase-done",
			"workflow.phase-started",
			"workflow.round-started",
		]);
		expect(broker.control.getWorkflow(workflowId)?.currentPhaseIndex).toBe(1);

		// Turn state re-points at the newly kicked-off next-phase handoff.
		const nextHandoff = broker.db
			.prepare(
				"SELECT handoff_id, sender_agent, target_agent FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
			)
			.get(workflowId) as {
			handoff_id: string;
			sender_agent: string;
			target_agent: string;
		};
		const turnState = broker.control.getRelayTurnState(COLLAB_ID);
		expect(turnState?.unresolvedHandoffId).toBe(nextHandoff.handoff_id);
		expect(turnState?.turnOwner).toBe(nextHandoff.target_agent);
		expect(turnState?.waitingAgent).toBe(nextHandoff.sender_agent);
		expect(turnState?.handoffState).toBe("pending");
		expect(turnState?.chainStatus).toBe("active");
	});

	it("review + findings → next handoff=fix, currentRound unchanged", () => {
		const { broker, handoffId, chainId } = setup();
		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "findings",
			confidence: 0.8,
			reason: "typos in section 3",
			followUpMessage: "fix typos in section 3",
			now: "2026-04-21T00:10:00Z",
		});
		expect(result.action).toBe("chain-continued");
		expect(result.nextHandoffId).toBeDefined();
		expect(broker.control.getRelayChain(chainId)?.currentRound).toBe(1);

		// Turn state now points at the fix handoff (roles flipped vs the prior review).
		const turnState = broker.control.getRelayTurnState(COLLAB_ID);
		expect(turnState?.unresolvedHandoffId).toBe(result.nextHandoffId);
		expect(turnState?.turnOwner).toBe("claude");
		expect(turnState?.waitingAgent).toBe("codex");
		expect(turnState?.handoffState).toBe("pending");
		expect(turnState?.chainStatus).toBe("active");
	});

	it("review + findings at maxRounds → normalized escalate", () => {
		const { broker, handoffId, chainId } = setup();
		// Force chain to round 5 (maxRounds)
		broker.db
			.prepare("UPDATE relay_chains SET current_round = 5 WHERE chain_id = ?")
			.run(chainId);

		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "findings",
			confidence: 0.8,
			reason: "still broken",
			now: "2026-04-21T00:15:00Z",
		});
		expect(result.action).toBe("workflow-halted");
		const chain = broker.control.getRelayChain(chainId);
		expect(chain?.status).toBe("escalated");
		expect(chain?.terminalReason).toMatch(/max-rounds-reached/);
	});

	it("low confidence normalized to escalate", () => {
		const { broker, handoffId } = setup();
		const result = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "approve",
			confidence: 0.3,
			reason: "unsure",
			now: "2026-04-21T00:10:00Z",
		});
		expect(result.action).toBe("workflow-halted");
	});

	it("illegal step verdict (fix + approve) normalized to escalate", () => {
		const { broker, workflowId } = setup();
		const firstHandoff = broker.control.getWorkflowPhaseRuns(workflowId)[0];
		if (!firstHandoff) throw new Error("expected a phase run");
		const firstRow = broker.db
			.prepare("SELECT handoff_id FROM relay_handoff WHERE phase_run_id = ?")
			.get(firstHandoff.phaseRunId) as { handoff_id: string };
		const { nextHandoffId } = broker.control.applyOrchestratorVerdict({
			handoffId: firstRow.handoff_id,
			verdict: "findings",
			confidence: 0.8,
			reason: "fix these",
			followUpMessage: "fix details",
			now: "2026-04-21T00:10:00Z",
		});
		expect(nextHandoffId).toBeDefined();

		const result = broker.control.applyOrchestratorVerdict({
			handoffId: nextHandoffId!,
			verdict: "approve",
			confidence: 0.9,
			reason: "looks good",
			now: "2026-04-21T00:15:00Z",
		});
		expect(result.action).toBe("workflow-halted");
	});

	it("second call with same handoffId is a no-op", () => {
		const { broker, handoffId } = setup();
		const first = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "approve",
			confidence: 0.9,
			reason: "good",
			now: "2026-04-21T00:10:00Z",
		});
		expect(first.action).toBe("phase-advanced");

		const second = broker.control.applyOrchestratorVerdict({
			handoffId,
			verdict: "approve",
			confidence: 0.9,
			reason: "good",
			now: "2026-04-21T00:11:00Z",
		});
		expect(second.action).toBe("noop-already-applied");
	});
});

describe("applyOrchestratorVerdict — advancing into plan-execution requires workspaceHeadSha", () => {
	it("plan-writing approve without workspaceHeadSha aborts", () => {
		const { broker, workflowId } = setup();
		// Walk through spec-refining approve to reach plan-writing
		const handoffs = broker.db
			.prepare(
				"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at",
			)
			.all(workflowId) as Array<{ handoff_id: string }>;
		if (!handoffs[0]) throw new Error("expected at least one handoff");
		broker.control.applyOrchestratorVerdict({
			handoffId: handoffs[0].handoff_id,
			verdict: "approve",
			confidence: 0.9,
			reason: "spec good",
			now: "2026-04-21T00:10:00Z",
		});
		// Now on plan-writing implement step. Simulate implementer delivered.
		const planImplementHandoff = broker.db
			.prepare(
				"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'implement' ORDER BY created_at DESC LIMIT 1",
			)
			.get(workflowId) as { handoff_id: string };
		broker.control.applyOrchestratorVerdict({
			handoffId: planImplementHandoff.handoff_id,
			verdict: "delivered",
			confidence: 0.9,
			reason: "plan written",
			now: "2026-04-21T00:11:00Z",
		});
		// Turn state after delivered: points at the newly-created review handoff
		const afterDelivered = broker.control.getRelayTurnState(COLLAB_ID);
		expect(afterDelivered?.turnOwner).toBe("codex");
		expect(afterDelivered?.waitingAgent).toBe("claude");
		expect(afterDelivered?.handoffState).toBe("pending");
		expect(afterDelivered?.chainStatus).toBe("active");
		// Now plan-writing is on review. Approving without workspaceHeadSha must abort.
		const planReviewHandoff = broker.db
			.prepare(
				"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' AND phase_run_id IN (SELECT phase_run_id FROM workflow_phases WHERE phase_index = 1) ORDER BY created_at DESC LIMIT 1",
			)
			.get(workflowId) as { handoff_id: string };
		expect(() =>
			broker.control.applyOrchestratorVerdict({
				handoffId: planReviewHandoff.handoff_id,
				verdict: "approve",
				confidence: 0.9,
				reason: "plan good",
				now: "2026-04-21T00:12:00Z",
			}),
		).toThrow(/workspaceHeadSha/);
	});
});

describe("applyOrchestratorVerdict — execution-fail", () => {
	it("execution-fail → workflow-halted, chain escalated", () => {
		const { broker, workflowId, handoffId } = setup();

		const { executeHandoffId, chainId } = driveToExecutePhase(broker, workflowId, handoffId);

		const result = broker.control.applyOrchestratorVerdict({
			handoffId: executeHandoffId,
			verdict: "execution-fail",
			confidence: 0.9,
			reason: "tests failed",
			now: "2026-04-21T00:20:00Z",
		});

		expect(result.action).toBe("workflow-halted");
		expect(broker.control.getRelayChain(chainId)?.status).toBe("escalated");
		expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
	});
});

describe("applyOrchestratorVerdict — workflow-done emission sequence", () => {
	it("last-phase approve emits chain.resolved, workflow.phase-done, workflow.done in order", () => {
		const { broker, workflowId, handoffId } = setup();
		const seen: string[] = [];

		const { executeHandoffId } = driveToExecutePhase(broker, workflowId, handoffId);

		// execution-pass → advances to code-review phase
		broker.control.applyOrchestratorVerdict({
			handoffId: executeHandoffId,
			verdict: "execution-pass",
			confidence: 0.95,
			reason: "tests passed",
			extractedCommitShas: ["abc1234", "def5678"],
			now: "2026-04-21T00:21:00Z",
		});

		// code-review review handoff
		const codeReviewRow = broker.db
			.prepare(
				"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' AND phase_run_id IN (SELECT phase_run_id FROM workflow_phases WHERE phase_index = 3) ORDER BY created_at DESC LIMIT 1",
			)
			.get(workflowId) as { handoff_id: string };

		// Subscribe after setup so we only capture the final approval events
		for (const name of [
			"chain.resolved",
			"workflow.phase-done",
			"workflow.done",
		] as const) {
			broker.events.on(name, () => seen.push(name));
		}

		const result = broker.control.applyOrchestratorVerdict({
			handoffId: codeReviewRow.handoff_id,
			verdict: "approve",
			confidence: 0.9,
			reason: "code looks great",
			now: "2026-04-21T00:22:00Z",
		});

		expect(result.action).toBe("workflow-done");
		expect(seen).toEqual(["chain.resolved", "workflow.phase-done", "workflow.done"]);
	});
});

describe("applyOrchestratorVerdict — execution-pass commit context", () => {
	it("execution-pass with extractedCommitShas stores commit range in workflowContext", () => {
		const { broker, workflowId, handoffId } = setup();

		const { executeHandoffId } = driveToExecutePhase(broker, workflowId, handoffId);

		broker.control.applyOrchestratorVerdict({
			handoffId: executeHandoffId,
			verdict: "execution-pass",
			confidence: 0.95,
			reason: "all green",
			extractedCommitShas: ["aaa1111", "bbb2222"],
			now: "2026-04-21T00:20:00Z",
		});

		const wf = broker.control.getWorkflow(workflowId);
		const ctx = wf?.workflowContext as {
			executionCommitShas?: string[];
			headAfterExecution?: string;
			commitRange?: string;
		};
		expect(ctx?.executionCommitShas).toEqual(["aaa1111", "bbb2222"]);
		expect(ctx?.headAfterExecution).toBe("bbb2222");
		// base is the workspaceHeadSha used when entering the execute phase
		expect(ctx?.commitRange).toBe("abc1234..bbb2222");
	});
});
