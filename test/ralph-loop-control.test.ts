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
				"SELECT request_text FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'review' ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(workflowId) as { request_text: string }
	).request_text;
}

function latestHandoffIdForStep(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
	step: string,
): string {
	return (
		broker.db
			.prepare(
				"SELECT handoff_id FROM relay_handoff WHERE workflow_id = ? AND handoff_step = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(workflowId, step) as { handoff_id: string }
	).handoff_id;
}

function countOpenPhaseRuns(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
): number {
	return (
		broker.db
			.prepare(
				"SELECT COUNT(*) AS n FROM workflow_phases WHERE workflow_id = ? AND ended_at IS NULL",
			)
			.get(workflowId) as { n: number }
	).n;
}

function patchRalphIteration(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
	iteration: number,
) {
	const row = broker.db
		.prepare("SELECT workflow_context FROM workflows WHERE workflow_id = ?")
		.get(workflowId) as { workflow_context: string };
	const ctx = JSON.parse(row.workflow_context) as Record<string, unknown>;
	ctx.ralphIteration = iteration;
	broker.db
		.prepare("UPDATE workflows SET workflow_context = ? WHERE workflow_id = ?")
		.run(JSON.stringify(ctx), workflowId);
}

/**
 * Drive a ralph workflow to a review-step approve: start the implement
 * handoff, hand it back with the given marker, apply `delivered` (→ creates the
 * review handoff), then hand back + return the review handoff id ready for the
 * approve verdict.
 */
function driveToReviewApprove(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
	implementHandoffId: string,
	implementMarker: string,
	now: string,
): string {
	setHandback(
		broker,
		implementHandoffId,
		`Did the work.\n${implementMarker}`,
	);
	broker.control.applyOrchestratorVerdict({
		handoffId: implementHandoffId,
		verdict: "delivered",
		confidence: 0.9,
		reason: "implementer delivered",
		now,
	});
	const reviewHandoffId = latestHandoffIdForStep(broker, workflowId, "review");
	setHandback(broker, reviewHandoffId, "Looks good, approving.");
	return reviewHandoffId;
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

	// Spec §5.4/§7 — the claim is derived from the FINAL non-empty line, not a bare
	// substring. A normal item handback may quote [[RALPH:GOAL-COMPLETE]] earlier
	// (e.g. describing the loop) yet end with [[RALPH:ITEM-DELIVERED]]: claim must
	// be false and the per-item review prompt (not the acceptance gate) must render.
	it("goal marker quoted earlier + item marker on final line → claim false, per-item review", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			setHandback(
				broker,
				handoffId,
				"Noted that the loop ends only when I emit [[RALPH:GOAL-COMPLETE]], but work remains.\n[[RALPH:ITEM-DELIVERED]]",
			);

			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "implementer delivered an item (goal marker only quoted)",
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

describe("applyOrchestratorVerdict — ralph review approve mechanics", () => {
	it("loop: claim falsy → re-kicks SAME phase, increments ralphIteration", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			const reviewHandoffId = driveToReviewApprove(
				broker,
				workflowId,
				handoffId,
				"[[RALPH:ITEM-DELIVERED]]",
				new Date().toISOString(),
			);

			// On the loop path the workflow must NOT terminate: subscribe before
			// applying and assert no terminal workflow event is emitted (only the
			// re-kick events like workflow.phase-done / phase-started should fire).
			const terminal: string[] = [];
			for (const name of ["workflow.done", "workflow.halted"] as const) {
				broker.events.on(name, () => terminal.push(name));
			}

			const result = broker.control.applyOrchestratorVerdict({
				handoffId: reviewHandoffId,
				verdict: "approve",
				confidence: 0.9,
				reason: "item accepted",
				now: new Date().toISOString(),
			});

			expect(result.action).toBe("phase-advanced");
			expect(terminal).toEqual([]);
			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("running");
			// Same phase — never incremented.
			expect(wf?.currentPhaseIndex).toBe(0);
			expect(
				(wf?.workflowContext as { ralphIteration?: number }).ralphIteration,
			).toBe(1);
			// A fresh open phase run exists for the next item.
			expect(countOpenPhaseRuns(broker, workflowId)).toBe(1);
			// The re-kick produced a NEW implement handoff. Assert via the verdict
			// return value (which carries the next handoff id) rather than a
			// timestamp-ordered DB query, so a same-ms tie cannot make this flaky.
			expect(result.nextHandoffId).toBeDefined();
			expect(result.nextHandoffId).not.toBe(handoffId);
		} finally {
			await broker.stop();
		}
	});

	it("complete: claim true → workflow done + workflow.done event", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			const reviewHandoffId = driveToReviewApprove(
				broker,
				workflowId,
				handoffId,
				"[[RALPH:GOAL-COMPLETE]]",
				new Date().toISOString(),
			);

			const seen: string[] = [];
			for (const name of [
				"chain.resolved",
				"workflow.phase-done",
				"workflow.done",
			] as const) {
				broker.events.on(name, () => seen.push(name));
			}

			const result = broker.control.applyOrchestratorVerdict({
				handoffId: reviewHandoffId,
				verdict: "approve",
				confidence: 0.95,
				reason: "acceptance gate passed",
				now: new Date().toISOString(),
			});

			expect(result.action).toBe("workflow-done");
			expect(broker.control.getWorkflow(workflowId)?.status).toBe("done");
			expect(seen).toEqual([
				"chain.resolved",
				"workflow.phase-done",
				"workflow.done",
			]);
		} finally {
			await broker.stop();
		}
	});

	it("cap: ralphIteration at maxIterations-1, claim falsy → halted + workflow.halted event", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { workflowId, handoffId } = startRalphWorkflow(broker);
			// ralph-loop default maxIterations is 100 → seed at 99 so the next
			// iteration (100) hits the cap.
			patchRalphIteration(broker, workflowId, 99);
			const reviewHandoffId = driveToReviewApprove(
				broker,
				workflowId,
				handoffId,
				"[[RALPH:ITEM-DELIVERED]]",
				new Date().toISOString(),
			);
			// The `delivered` verdict inside driveToReviewApprove only patches
			// ralphCompletionClaim, so the seeded ralphIteration=99 survives.

			const halted: unknown[] = [];
			broker.events.on("workflow.halted", (e) => halted.push(e));

			const result = broker.control.applyOrchestratorVerdict({
				handoffId: reviewHandoffId,
				verdict: "approve",
				confidence: 0.9,
				reason: "item accepted",
				now: new Date().toISOString(),
			});

			expect(result.action).toBe("workflow-halted");
			const wf = broker.control.getWorkflow(workflowId);
			expect(wf?.status).toBe("halted");
			expect(wf?.haltReason).toContain("maxIterations");
			expect(halted).toHaveLength(1);
		} finally {
			await broker.stop();
		}
	});
});

describe("applyOrchestratorVerdict — ralph findings uses the ralph fix template", () => {
	it("the fix handoff carries LEARNINGS.md + the item marker + ralphDir + the findings", async () => {
		const broker = makeRalphBroker();
		try {
			const now = "2026-05-21T00:00:00.000Z";
			seedRalphCollab(broker, now);
			const { workflowId, handoffId } = startRalphWorkflow(broker, now);

			// implement → delivered (item) → review handoff
			setHandback(broker, handoffId, "Did the work.\n[[RALPH:ITEM-DELIVERED]]");
			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "delivered",
				now,
			});
			const reviewHandoffId = latestHandoffIdForStep(broker, workflowId, "review");
			setHandback(broker, reviewHandoffId, "Findings: the chunk is incomplete.");

			// review → findings → fix handoff
			broker.control.applyOrchestratorVerdict({
				handoffId: reviewHandoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "reviewer raised findings",
				followUpMessage: "Handle the empty-input edge case.",
				now,
			});

			const fixReq = (
				broker.db
					.prepare(
						"SELECT request_text FROM relay_handoff WHERE workflow_id = ? AND handoff_step = 'fix' ORDER BY created_at DESC, rowid DESC LIMIT 1",
					)
					.get(workflowId) as { request_text: string }
			).request_text;

			// Anti-amnesia: the ralph fix template (not the generic SDD prompt) is used.
			expect(fixReq).toContain("LEARNINGS.md");
			expect(fixReq).toContain("[[RALPH:ITEM-DELIVERED]]");
			expect(fixReq).toContain(ralphRunDir("/tmp/ralph", workflowId)); // ralphDir rendered (workspaceRoot from seedRalphCollab)
			expect(fixReq).toContain("Handle the empty-input edge case."); // findings appended
		} finally {
			await broker.stop();
		}
	});
});
