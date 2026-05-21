import { describe, expect, it } from "vitest";
import { resolveEvaluatorPromptKey } from "../packages/cli/src/runtime/relay-orchestrator.ts";

describe("resolveEvaluatorPromptKey", () => {
	it("uses the phase's configured key for ralph-loop", () => {
		expect(
			resolveEvaluatorPromptKey({ workflowType: "ralph-loop", phaseName: "ralph-iteration", handoffStep: "review" }),
		).toBe("ralph-loop");
	});
	it("falls back to handoffStep derivation for SDD review/execute", () => {
		expect(
			resolveEvaluatorPromptKey({ workflowType: "spec-driven-development", phaseName: "code-review", handoffStep: "review" }),
		).toBe("review-loop");
		expect(
			resolveEvaluatorPromptKey({ workflowType: "spec-driven-development", phaseName: "plan-execution", handoffStep: "execute" }),
		).toBe("execution-gate");
	});
	it("falls back when type/phase unknown", () => {
		expect(
			resolveEvaluatorPromptKey({ workflowType: "nope", phaseName: "x", handoffStep: "execute" }),
		).toBe("execution-gate");
	});
});
