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
		workflowType: "superpowers-feature-development",
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
