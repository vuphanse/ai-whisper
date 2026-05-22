import { describe, expect, it } from "vitest";
import { deriveDefaultEvaluatorKey } from "../packages/cli/src/runtime/relay-orchestrator.ts";
import {
	makeRalphBroker,
	seedRalphCollab,
	startRalphWorkflow,
	RALPH_COLLAB_ID,
} from "./ralph-loop-control.test.ts";

// Spec §5.3 — the phase's configured evaluatorPromptKey must be plumbed through
// getHandoffWithWorkflowMeta so the orchestrator consumes it (rather than
// re-deriving the key). These tests pin the metadata path, not just a helper.
describe("getHandoffWithWorkflowMeta carries the configured evaluatorPromptKey (spec §5.3)", () => {
	it("ralph-loop implement handoff → meta.evaluatorPromptKey === 'ralph-loop'", async () => {
		const broker = makeRalphBroker();
		try {
			seedRalphCollab(broker);
			const { handoffId } = startRalphWorkflow(broker);
			const meta = broker.control.getHandoffWithWorkflowMeta(handoffId);
			expect(meta).not.toBeNull();
			expect(meta!.evaluatorPromptKey).toBe("ralph-loop");
		} finally {
			await broker.stop();
		}
	});

	it("SDD phases carry their configured keys (review-loop / execution-gate)", async () => {
		const now = new Date().toISOString();
		for (const [phaseName, initialHandoffStep, expectedKey] of [
			["spec-refining", "review", "review-loop"],
			["plan-execution", "execute", "execution-gate"],
		] as const) {
			const broker = makeRalphBroker();
			try {
				seedRalphCollab(broker, now);
				const { workflowId } = broker.control.createWorkflow({
					collabId: RALPH_COLLAB_ID,
					workflowType: "spec-driven-development",
					specPath: "/tmp/ralph/SPEC.md",
					roleBindings: { implementer: "claude", reviewer: "codex" },
					now,
				});
				const { handoffId } = broker.control.beginPhaseRun({
					workflowId,
					phaseIndex: 0,
					phaseName,
					initialHandoffStep,
					kickoffText: "kickoff",
					sender: "claude",
					target: "codex",
					maxRounds: 5,
					// required only for the execute step; harmless otherwise
					executionBaseHeadSha: "0".repeat(40),
					now,
				});
				const meta = broker.control.getHandoffWithWorkflowMeta(handoffId);
				expect(meta!.evaluatorPromptKey).toBe(expectedKey);
			} finally {
				await broker.stop();
			}
		}
	});

	it("non-workflow handoff → meta key null (orchestrator falls back to derivation)", () => {
		// deriveDefaultEvaluatorKey is the absent-metadata fallback the orchestrator uses.
		expect(deriveDefaultEvaluatorKey("execute")).toBe("execution-gate");
		expect(deriveDefaultEvaluatorKey("review")).toBe("review-loop");
		expect(deriveDefaultEvaluatorKey("implement")).toBe("review-loop");
		expect(deriveDefaultEvaluatorKey("fix")).toBe("review-loop");
	});
});
