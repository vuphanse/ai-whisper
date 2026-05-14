import { describe, expect, it } from "vitest";
import { formatVerdictsView } from "../packages/cli/src/runtime/operator-inspect-verdicts.ts";
import type { RelayEvaluatorDiagnosticRecord } from "../packages/broker/src/index.ts";

function sampleRow(overrides: Partial<RelayEvaluatorDiagnosticRecord> = {}): RelayEvaluatorDiagnosticRecord {
	return {
		evaluatorId: "eval_20260514T120000_abcd1234",
		handoffId: "handoff_0001",
		collabId: "collab_X",
		chainId: "chain_X1",
		workflowId: null,
		phaseRunId: null,
		evaluatorBranch: "legacy",
		evaluatorPromptKey: null,
		handoffStep: null,
		attemptKind: "primary",
		callGroupId: "cg_1",
		provider: "anthropic",
		outcome: "ok",
		verdict: "done",
		confidence: 0.85,
		reason: "deliverable matches request",
		followUpMessageLen: 0,
		latencyMs: 812,
		errorMessage: null,
		inputTokens: 412,
		outputTokens: 64,
		promptSample: "system prompt + payload",
		responseSample: "{\"verdict\":\"done\"...}",
		createdAt: "2026-05-14T12:00:00.000Z",
		...overrides,
	};
}

describe("formatVerdictsView", () => {
	it("renders empty state when no rows", () => {
		const out = formatVerdictsView({ rows: [], collabId: "collab_X" });
		expect(out).toContain("No evaluator diagnostics for collab_X");
	});

	it("renders header with the spec'd columns", () => {
		const out = formatVerdictsView({ rows: [sampleRow()], collabId: "collab_X" });
		expect(out).toContain("TIME");
		expect(out).toContain("BRANCH");
		expect(out).toContain("PROVIDER");
		expect(out).toContain("ATTEMPT");
		expect(out).toContain("OUTCOME");
		expect(out).toContain("VERDICT");
		expect(out).toContain("CONF");
		expect(out).toContain("LAT(ms)");
		expect(out).toContain("TOK(in/out)");
		expect(out).toContain("HANDOFF");
		expect(out).toContain("REASON");
	});

	it("renders a row with all key values", () => {
		const out = formatVerdictsView({ rows: [sampleRow()], collabId: "collab_X" });
		expect(out).toContain("legacy");
		expect(out).toContain("anthropic");
		expect(out).toContain("primary");
		expect(out).toContain("ok");
		expect(out).toContain("done");
		expect(out).toContain("0.85");
		expect(out).toContain("812");
		expect(out).toContain("412/64");
		expect(out).toContain("handoff_0001");
		expect(out).toContain("deliverable matches request");
	});

	it("shows TOK as -/- when both tokens are NULL (Ollama)", () => {
		const out = formatVerdictsView({
			rows: [sampleRow({ provider: "ollama", inputTokens: null, outputTokens: null })],
			collabId: "collab_X",
		});
		expect(out).toContain("-/-");
	});

	it("shows VERDICT as - when verdict is NULL (failure case) and falls back to error_message in REASON", () => {
		const out = formatVerdictsView({
			rows: [sampleRow({
				outcome: "provider_unavailable",
				verdict: null,
				confidence: null,
				reason: null,
				errorMessage: "ECONNREFUSED",
			})],
			collabId: "collab_X",
		});
		const lines = out.split("\n");
		const dataLine = lines.find((l) => l.includes("provider_unavailable"));
		expect(dataLine).toBeDefined();
		expect(dataLine).toContain("ECONNREFUSED");
	});

	it("truncates REASON to 60 chars", () => {
		const long = "x".repeat(200);
		const out = formatVerdictsView({
			rows: [sampleRow({ reason: long })],
			collabId: "collab_X",
		});
		expect(out).not.toMatch(/x{100,}/);
	});
});
