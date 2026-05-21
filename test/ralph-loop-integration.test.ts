import { describe, expect, it } from "vitest";
import {
	RALPH_COLLAB_ID,
	makeRalphBroker,
	seedRalphCollab,
	startRalphWorkflow,
} from "./ralph-loop-control.test.ts";

// ---------------------------------------------------------------------------
// Helpers (local — not worth exporting)
// ---------------------------------------------------------------------------

function setHandback(
	broker: ReturnType<typeof makeRalphBroker>,
	handoffId: string,
	text: string,
) {
	broker.db
		.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
		.run(text, handoffId);
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

function latestReviewRequestText(
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

function countTotalPhaseRuns(
	broker: ReturnType<typeof makeRalphBroker>,
	workflowId: string,
): number {
	return (
		broker.db
			.prepare("SELECT COUNT(*) AS n FROM workflow_phases WHERE workflow_id = ?")
			.get(workflowId) as { n: number }
	).n;
}

/** Increment an ISO timestamp by 1 ms */
function nextTs(ts: string): string {
	return new Date(new Date(ts).getTime() + 1).toISOString();
}

// ---------------------------------------------------------------------------
// Scenario A — multi-item loop to completion
// ---------------------------------------------------------------------------

describe("ralph-loop integration — Scenario A: multi-item loop to done", () => {
	it("k=2 normal items then completion cycle → workflow done, correct events + counters", async () => {
		const broker = makeRalphBroker();
		try {
			let ts = "2026-05-21T10:00:00.000Z";

			seedRalphCollab(broker, ts);
			ts = nextTs(ts);
			const { workflowId, handoffId: firstImplementHandoffId } = startRalphWorkflow(broker, ts);
			ts = nextTs(ts);

			// Subscribe to terminal events before any loop work
			const terminalEvents: string[] = [];
			for (const name of ["workflow.done", "workflow.halted"] as const) {
				broker.events.on(name, () => terminalEvents.push(name));
			}

			// Track phase run count: starts at 1 (from startRalphWorkflow)
			expect(countTotalPhaseRuns(broker, workflowId)).toBe(1);

			let currentImplementHandoffId = firstImplementHandoffId;
			let expectedIteration = 0;

			// ---- Two normal ITEM-DELIVERED cycles ----
			for (let item = 0; item < 2; item++) {
				// Deliver the implement handoff with ITEM-DELIVERED marker
				setHandback(
					broker,
					currentImplementHandoffId,
					`Delivered item ${item + 1}.\n[[RALPH:ITEM-DELIVERED]]`,
				);
				const deliveredResult = broker.control.applyOrchestratorVerdict({
					handoffId: currentImplementHandoffId,
					verdict: "delivered",
					confidence: 0.9,
					reason: `item ${item + 1} delivered`,
					now: ts,
				});
				ts = nextTs(ts);

				// After delivered: a review handoff must exist
				const reviewHandoffId = latestHandoffIdForStep(broker, workflowId, "review");
				expect(reviewHandoffId).toBeDefined();

				// Review request should be per-item (not acceptance gate)
				const reviewText = latestReviewRequestText(broker, workflowId);
				expect(reviewText).not.toContain("ENTIRE");
				expect(reviewText).toContain("latest delivered chunk");

				// The delivered verdict returned the review handoff id via the chain
				// (deliveredResult does not carry nextHandoffId — that is on approve; just verify
				// the review handoff exists via DB query above)
				expect(deliveredResult.action).toBe("chain-continued");

				// Approve the review
				setHandback(broker, reviewHandoffId, "Approved.");
				const approveResult = broker.control.applyOrchestratorVerdict({
					handoffId: reviewHandoffId,
					verdict: "approve",
					confidence: 0.9,
					reason: `item ${item + 1} accepted`,
					now: ts,
				});
				ts = nextTs(ts);

				expectedIteration += 1;

				// Loop: phase-advanced (re-kick same phase)
				expect(approveResult.action).toBe("phase-advanced");
				expect(approveResult.nextHandoffId).toBeDefined();

				// Workflow still running, same phase index
				const wf = broker.control.getWorkflow(workflowId);
				expect(wf?.status).toBe("running");
				expect(wf?.currentPhaseIndex).toBe(0);
				expect(
					(wf?.workflowContext as { ralphIteration?: number }).ralphIteration,
				).toBe(expectedIteration);

				// No terminal events yet
				expect(terminalEvents).toEqual([]);

				// Per-item phase run count grew
				expect(countTotalPhaseRuns(broker, workflowId)).toBe(item + 2);

				// Next implement handoff comes from the approve return value
				currentImplementHandoffId = approveResult.nextHandoffId!;
			}

			// After 2 items: 3 total phase runs (1 initial + 2 re-kicks)
			expect(countTotalPhaseRuns(broker, workflowId)).toBe(3);

			// ---- Completion cycle ----
			setHandback(
				broker,
				currentImplementHandoffId,
				"All goal items complete.\n[[RALPH:GOAL-COMPLETE]]",
			);
			broker.control.applyOrchestratorVerdict({
				handoffId: currentImplementHandoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "goal complete claim",
				now: ts,
			});
			ts = nextTs(ts);

			// Acceptance-gate review: request_text must contain "ENTIRE"
			const completionReviewHandoffId = latestHandoffIdForStep(broker, workflowId, "review");
			const completionReviewText = latestReviewRequestText(broker, workflowId);
			expect(completionReviewText).toContain("ENTIRE");

			// Subscribe to completion events BEFORE the final approve
			const completionEvents: string[] = [];
			for (const name of [
				"chain.resolved",
				"workflow.phase-done",
				"workflow.done",
			] as const) {
				broker.events.on(name, () => completionEvents.push(name));
			}

			setHandback(broker, completionReviewHandoffId, "Approved.");
			const finalResult = broker.control.applyOrchestratorVerdict({
				handoffId: completionReviewHandoffId,
				verdict: "approve",
				confidence: 0.95,
				reason: "acceptance gate passed",
				now: ts,
			});

			// Workflow done
			expect(finalResult.action).toBe("workflow-done");
			const doneWf = broker.control.getWorkflow(workflowId);
			expect(doneWf?.status).toBe("done");
			// Phase index never advanced beyond 0
			expect(doneWf?.currentPhaseIndex).toBe(0);

			// Terminal events in correct order
			expect(completionEvents).toEqual([
				"chain.resolved",
				"workflow.phase-done",
				"workflow.done",
			]);
			// terminalEvents subscribed early; workflow.done fires on completion cycle
			expect(terminalEvents).toEqual(["workflow.done"]);
		} finally {
			await broker.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Scenario B — inner escalation halts the whole workflow
// ---------------------------------------------------------------------------

describe("ralph-loop integration — Scenario B: inner escalation halts workflow", () => {
	it("findings at review with maxRounds=1 → escalate → workflow halted + workflow.halted event", async () => {
		const broker = makeRalphBroker();
		try {
			let ts = "2026-05-21T11:00:00.000Z";

			seedRalphCollab(broker, ts);
			ts = nextTs(ts);

			// Create workflow (no role bindings needed beyond what seedRalphCollab provides)
			const { workflowId } = broker.control.createWorkflow({
				collabId: RALPH_COLLAB_ID,
				workflowType: "ralph-loop",
				specPath: "/tmp/ralph/GOAL.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now: ts,
			});
			ts = nextTs(ts);

			// Begin a phase run with maxRounds=1 so the first findings at review escalates
			const { handoffId: implementHandoffId } = broker.control.beginPhaseRun({
				workflowId,
				phaseIndex: 0,
				phaseName: "ralph-iteration",
				initialHandoffStep: "implement",
				kickoffText: "Grind the goal.",
				sender: "claude",
				target: "codex",
				maxRounds: 1,
				now: ts,
			});
			ts = nextTs(ts);

			// Subscribe to halted event
			const haltedEvents: unknown[] = [];
			broker.events.on("workflow.halted", (e) => haltedEvents.push(e));

			// Deliver implement → creates review handoff (increments round to 2)
			setHandback(broker, implementHandoffId, "Attempted item.\n[[RALPH:ITEM-DELIVERED]]");
			broker.control.applyOrchestratorVerdict({
				handoffId: implementHandoffId,
				verdict: "delivered",
				confidence: 0.9,
				reason: "implementer delivered",
				now: ts,
			});
			ts = nextTs(ts);

			const reviewHandoffId = latestHandoffIdForStep(broker, workflowId, "review");

			// Apply findings at review: currentRound=2, maxRounds=1 → 2+1>1 → escalate
			setHandback(broker, reviewHandoffId, "There are issues.");
			const escalateResult = broker.control.applyOrchestratorVerdict({
				handoffId: reviewHandoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "reviewer found issues",
				now: ts,
			});

			expect(escalateResult.action).toBe("workflow-halted");
			const haltedWf = broker.control.getWorkflow(workflowId);
			expect(haltedWf?.status).toBe("halted");
			expect(haltedWf?.haltReason).toBeTruthy();
			expect(haltedEvents).toHaveLength(1);
		} finally {
			await broker.stop();
		}
	});
});
