import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { ralphRunDir } from "../packages/broker/src/runtime/workflow-registry.ts";

describe("ralphRunDir", () => {
	it("joins workspace + .ai-whisper/ralph/<workflowId>", () => {
		expect(ralphRunDir("/ws", "wf_123")).toBe(join("/ws", ".ai-whisper", "ralph", "wf_123"));
	});
});

export const RALPH_COLLAB_ID = "collab_ralph";

/**
 * A real broker runtime with every background sweep disabled — safe to drive
 * synchronously via `broker.control`. Exported so Task 8 can reuse it.
 */
export function makeRalphBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-ralph-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "x.sqlite"),
		host: "127.0.0.1",
		port: 4731,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

/**
 * Seed an orchestrator-enabled collab with both agents bound, so ralph-loop's
 * defaults (implementer=claude, reviewer=codex) resolve. Exported for Task 8.
 */
export function seedRalphCollab(
	broker: ReturnType<typeof makeRalphBroker>,
	now = new Date().toISOString(),
) {
	broker.control.startCollab({
		collabId: RALPH_COLLAB_ID,
		workspaceRoot: "/tmp/ralph",
		displayName: "ralph",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 5,
		now,
	});
	for (const agent of ["codex", "claude"] as const) {
		broker.control.setSessionBinding({
			collabId: RALPH_COLLAB_ID,
			agentType: agent,
			sessionId: `session_${agent}_ralph`,
			bindingSource: "adopted",
			now,
		});
	}
}

/**
 * Start a ralph-loop workflow and kick off its first (implement) handoff.
 * Exported for Task 8.
 */
export function startRalphWorkflow(
	broker: ReturnType<typeof makeRalphBroker>,
	now = new Date().toISOString(),
) {
	const { workflowId } = broker.control.createWorkflow({
		collabId: RALPH_COLLAB_ID,
		workflowType: "ralph-loop",
		specPath: "/tmp/ralph/GOAL.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now,
	});
	const { handoffId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "ralph-iteration",
		initialHandoffStep: "implement",
		kickoffText: "Grind the goal at /tmp/ralph/GOAL.md.",
		sender: "claude",
		target: "codex",
		maxRounds: 5,
		now,
	});
	return { workflowId, handoffId };
}

function setHandback(
	broker: ReturnType<typeof makeRalphBroker>,
	handoffId: string,
	text: string,
) {
	broker.db
		.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
		.run(text, handoffId);
}

function latestReviewRequest(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
): string {
	return (
		broker.db
			.prepare(
				"SELECT request_text FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' ORDER BY created_at DESC LIMIT 1",
			)
			.get(workflowId) as { request_text: string }
	).request_text;
}

describe("applyOrchestratorVerdict — ralph delivered persists ralphCompletionClaim", () => {
	it("GOAL-COMPLETE marker → claim true, acceptance-gate review prompt", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			setHandback(
				broker,
				handoffId,
				"All goal items are done and PROGRESS.md shows no remaining work.\n[[RALPH:GOAL-COMPLETE]]",
			);

			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "implementer claims goal complete",
				now: new Date().toISOString(),
			});

			const wf = broker.control.getWorkflow(workflowId);
			expect(
				(wf?.workflowContext as { ralphCompletionClaim?: boolean })
					.ralphCompletionClaim,
			).toBe(true);
			expect(latestReviewRequest(broker, workflowId)).toContain("ENTIRE");
		} finally {
			await broker.stop();
		}
	});

	it("ITEM-DELIVERED marker → claim falsy, per-item review prompt", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			setHandback(
				broker,
				handoffId,
				"Delivered the next chunk and updated PROGRESS.md.\n[[RALPH:ITEM-DELIVERED]]",
			);

			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "implementer delivered an item",
				now: new Date().toISOString(),
			});

			const wf = broker.control.getWorkflow(workflowId);
			expect(
				(wf?.workflowContext as { ralphCompletionClaim?: boolean })
					.ralphCompletionClaim,
			).toBeFalsy();
			const reviewText = latestReviewRequest(broker, workflowId);
			expect(reviewText).not.toContain("ENTIRE");
			expect(reviewText).toContain("latest delivered chunk");
		} finally {
			await broker.stop();
		}
	});
});
