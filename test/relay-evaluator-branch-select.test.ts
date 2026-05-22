import { describe, expect, it } from "vitest";
import {
	selectBranch,
	type WorkflowEvaluatorInput,
} from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

type SchemaWithVerdictEnum = { properties: { verdict: { enum: unknown[] } } };

function getVerdictEnum(schema: Record<string, unknown>): unknown[] {
	return (schema as unknown as SchemaWithVerdictEnum).properties.verdict.enum;
}

function makeWorkflowPayload(
	overrides: Partial<WorkflowEvaluatorInput> = {},
): WorkflowEvaluatorInput {
	return {
		rootRequestText: "r",
		requestText: "r",
		handbackText: "x",
		senderAgent: "codex",
		targetAgent: "claude",
		roundNumber: 1,
		maxRounds: 3,
		captureStatus: "ok",
		evaluatorPromptKey: "review-loop",
		workflowId: "w",
		phaseRunId: "p",
		phaseName: "ralph-iteration",
		handoffStep: "review",
		...overrides,
	};
}

describe("selectBranch ralph-loop", () => {
	it("implement/fix → delivered schema (delivered|escalate)", () => {
		for (const handoffStep of ["implement", "fix"] as const) {
			const b = selectBranch(makeWorkflowPayload({ evaluatorPromptKey: "ralph-loop", handoffStep }));
			expect(getVerdictEnum(b.jsonSchema)).toEqual(["delivered", "escalate"]);
		}
	});
	it("review → review schema (approve|findings|escalate)", () => {
		const b = selectBranch(makeWorkflowPayload({ evaluatorPromptKey: "ralph-loop", handoffStep: "review" }));
		expect(getVerdictEnum(b.jsonSchema)).toEqual(["approve", "findings", "escalate"]);
	});
	it("review-loop still dispatches as before", () => {
		const b = selectBranch(makeWorkflowPayload({ evaluatorPromptKey: "review-loop", handoffStep: "review" }));
		expect(getVerdictEnum(b.jsonSchema)).toEqual(["approve", "findings", "escalate"]);
	});

	// Spec §5.4/§7 — ralph-loop implement/fix classification must route on the EXACT
	// markers, not generic substantive-work detection. The ralph delivered branch's
	// prompt names both exact tokens; the review-loop delivered prompt does not.
	it("ralph-loop implement/fix prompt requires the exact markers", () => {
		for (const handoffStep of ["implement", "fix"] as const) {
			const b = selectBranch(makeWorkflowPayload({ evaluatorPromptKey: "ralph-loop", handoffStep }));
			expect(b.systemPrompt).toContain("[[RALPH:ITEM-DELIVERED]]");
			expect(b.systemPrompt).toContain("[[RALPH:GOAL-COMPLETE]]");
			// it must instruct escalation when neither marker is present
			expect(b.systemPrompt).toMatch(/escalate/i);
		}
	});

	it("review-loop implement/fix prompt is the generic delivered prompt (no ralph markers)", () => {
		for (const handoffStep of ["implement", "fix"] as const) {
			const b = selectBranch(makeWorkflowPayload({ evaluatorPromptKey: "review-loop", handoffStep }));
			expect(b.systemPrompt).not.toContain("[[RALPH:ITEM-DELIVERED]]");
			expect(b.systemPrompt).not.toContain("[[RALPH:GOAL-COMPLETE]]");
		}
	});
});
