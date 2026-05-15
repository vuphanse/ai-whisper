import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createRelayOrchestrator } from "../packages/cli/src/runtime/relay-orchestrator.ts";
import type { EvaluatorCall } from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

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
			sessionId: agent === "claude" ? "session_claude" : "session_codex",
			bindingSource: "adopted",
			now: "2026-04-21T00:00:00Z",
		});
	}
	return broker;
}

describe("RelayOrchestrator — workflow-aware routing", () => {
	it("legacy (non-workflow) chain still uses resolveRelayChain path", async () => {
		const broker = boot();
		broker.control.createRelayHandoff({
			handoffId: "ho_legacy",
			collabId: "collab_c1",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "review",
			now: "2026-04-21T00:00:00Z",
		});
		broker.control.acceptRelayHandoff({
			handoffId: "ho_legacy",
			acceptedAt: "2026-04-21T00:00:05Z",
		});
		broker.control.handoffBackRelay({
			handoffId: "ho_legacy",
			nextHandoffId: "ho_unused",
			senderAgent: "claude",
			targetAgent: "codex",
			requestText: "done",
			now: "2026-04-21T00:00:10Z",
		});

		const orchestrator = createRelayOrchestrator({
			broker,
			collabId: "collab_c1",
			evaluate: async () => ({ verdict: "done", confidence: 0.9, reason: "ok" }),
			readWorkspaceHead: async () => "abcdef1",
			pollIntervalMs: 10,
		});
		await orchestrator.pollOnce();
		const row = broker.db
			.prepare("SELECT orchestrator_status, orchestrator_verdict FROM relay_handoff WHERE handoff_id = ?")
			.get("ho_legacy") as { orchestrator_status: string; orchestrator_verdict: string };
		expect(row.orchestrator_status).toBe("processed");
		expect(row.orchestrator_verdict).toBe("done");
	});

	it("workflow chain routes through applyOrchestratorVerdict", async () => {
		const broker = boot();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		const { handoffId } = broker.control.beginPhaseRun({
			workflowId,
			phaseIndex: 0,
			phaseName: "spec-refining",
			initialHandoffStep: "review",
			kickoffText: "Review",
			sender: "claude",
			target: "codex",
			maxRounds: 5,
			now: "2026-04-21T00:01:00Z",
		});
		broker.control.acceptRelayHandoff({
			handoffId,
			acceptedAt: "2026-04-21T00:01:10Z",
		});
		broker.control.handoffBackRelay({
			handoffId,
			nextHandoffId: "unused",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "spec approved",
			now: "2026-04-21T00:01:20Z",
		});

		const orchestrator = createRelayOrchestrator({
			broker,
			collabId: "collab_c1",
			evaluate: async (call: EvaluatorCall) => {
				expect((call.payload as { evaluatorPromptKey?: string }).evaluatorPromptKey).toBe("review-loop");
				return {
					verdict: "approve",
					confidence: 0.95,
					reason: "spec good",
				};
			},
			readWorkspaceHead: async () => "abcdef1234567890abcdef1234567890abcdef12",
			pollIntervalMs: 10,
		});
		await orchestrator.pollOnce();

		expect(broker.control.getWorkflow(workflowId)?.currentPhaseIndex).toBe(1);
	});

	it("workflow chain: evaluator escalate → workflow halted", async () => {
		const broker = boot();
		const { workflowId } = broker.control.createWorkflow({
			collabId: "collab_c1",
			workflowType: "spec-driven-development",
			specPath: "docs/spec.md",
			roleBindings: { implementer: "claude", reviewer: "codex" },
			now: "2026-04-21T00:00:00Z",
		});
		const { handoffId } = broker.control.beginPhaseRun({
			workflowId,
			phaseIndex: 0,
			phaseName: "spec-refining",
			initialHandoffStep: "review",
			kickoffText: "Review",
			sender: "claude",
			target: "codex",
			maxRounds: 5,
			now: "2026-04-21T00:01:00Z",
		});
		broker.control.acceptRelayHandoff({ handoffId, acceptedAt: "2026-04-21T00:01:10Z" });
		broker.control.handoffBackRelay({
			handoffId,
			nextHandoffId: "unused2",
			senderAgent: "codex",
			targetAgent: "claude",
			requestText: "cannot continue",
			now: "2026-04-21T00:01:20Z",
		});

		const orchestrator = createRelayOrchestrator({
			broker,
			collabId: "collab_c1",
			evaluate: async () => ({ verdict: "escalate", confidence: 0.9, reason: "cannot proceed" }),
			readWorkspaceHead: async () => "abcdef1234567890abcdef1234567890abcdef12",
			pollIntervalMs: 10,
		});
		await orchestrator.pollOnce();

		expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
	});
});
