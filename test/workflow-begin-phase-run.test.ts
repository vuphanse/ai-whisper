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
	return { broker, workflowId };
}

describe("beginPhaseRun", () => {
	it("inserts phase-run + chain + handoff atomically for review phase", () => {
		const { broker, workflowId } = setup();
		const phaseStarted: unknown[] = [];
		const roundStarted: unknown[] = [];
		broker.events.on("workflow.phase-started", (e) => phaseStarted.push(e));
		broker.events.on("workflow.round-started", (e) => roundStarted.push(e));

		const result = broker.control.beginPhaseRun({
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

		expect(result.phaseRunId).toMatch(/^wfp_/);
		expect(result.chainId).toMatch(/^relay_ch_/);
		expect(result.handoffId).toMatch(/^ho_/);

		expect(broker.control.getRelayChain(result.chainId)?.maxRounds).toBe(5);
		expect(broker.control.getWorkflowPhaseRuns(workflowId)).toHaveLength(1);
		expect(phaseStarted).toHaveLength(1);
		expect(roundStarted).toHaveLength(1);

		// Turn state must reflect the new pending handoff so mount panes see it.
		const turnState = broker.control.getRelayTurnState(COLLAB_ID);
		expect(turnState?.unresolvedHandoffId).toBe(result.handoffId);
		expect(turnState?.turnOwner).toBe("codex");
		expect(turnState?.waitingAgent).toBe("claude");
		expect(turnState?.handoffState).toBe("pending");
		expect(turnState?.chainStatus).toBe("active");
		expect(turnState?.currentRound).toBe(1);
		expect(turnState?.maxRounds).toBe(5);
	});

	it("rejects initialHandoffStep=execute without executionBaseHeadSha", () => {
		const { broker, workflowId } = setup();
		expect(() =>
			broker.control.beginPhaseRun({
				workflowId,
				phaseIndex: 2,
				phaseName: "plan-execution",
				initialHandoffStep: "execute",
				kickoffText: "Execute the plan.",
				sender: "codex",
				target: "claude",
				maxRounds: 1,
				now: "2026-04-21T00:01:00Z",
			}),
		).toThrow(/executionBaseHeadSha/);
	});

	it("writes baseBeforeExecution into workflow_context on execute start", () => {
		const { broker, workflowId } = setup();
		broker.control.beginPhaseRun({
			workflowId,
			phaseIndex: 2,
			phaseName: "plan-execution",
			initialHandoffStep: "execute",
			kickoffText: "Execute the plan.",
			sender: "codex",
			target: "claude",
			maxRounds: 1,
			executionBaseHeadSha: "abc1234",
			now: "2026-04-21T00:02:00Z",
		});
		const wf = broker.control.getWorkflow(workflowId);
		expect((wf?.workflowContext as { baseBeforeExecution?: string }).baseBeforeExecution).toBe(
			"abc1234",
		);
	});

	it("rejects malformed executionBaseHeadSha", () => {
		const { broker, workflowId } = setup();
		expect(() =>
			broker.control.beginPhaseRun({
				workflowId,
				phaseIndex: 2,
				phaseName: "plan-execution",
				initialHandoffStep: "execute",
				kickoffText: "Execute.",
				sender: "codex",
				target: "claude",
				maxRounds: 1,
				executionBaseHeadSha: "not-a-sha",
				now: "2026-04-21T00:02:00Z",
			}),
		).toThrow(/executionBaseHeadSha/);
	});
});
