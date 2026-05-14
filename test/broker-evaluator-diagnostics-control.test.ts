import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-eval-diag-ctrl-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4603 });
}

describe("broker.control evaluator diagnostics", () => {
	it("recordEvaluatorDiagnostic writes a row and listEvaluatorDiagnosticsByCollab returns it", () => {
		const broker = newBroker();
		try {
			broker.control.recordEvaluatorDiagnostic({
				handoffId: "handoff_1",
				collabId: "collab_a",
				chainId: "chain_1",
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
				confidence: 0.9,
				reason: "matches request",
				followUpMessageLen: 0,
				latencyMs: 700,
				errorMessage: null,
				inputTokens: 600,
				outputTokens: 80,
				promptSample: "sample prompt",
				responseSample: "sample response",
				now: "2026-05-14T10:00:00.000Z",
			});

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_a", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.outcome).toBe("ok");
			expect(rows[0]?.evaluatorId.startsWith("eval_")).toBe(true);
			expect(rows[0]?.callGroupId).toBe("cg_1");
		} finally {
			void broker.stop();
		}
	});

	it("sweepEvaluatorDiagnostics returns the deleted-row count", () => {
		const broker = newBroker();
		try {
			broker.control.recordEvaluatorDiagnostic({
				handoffId: "h_old", collabId: "x", chainId: null, workflowId: null, phaseRunId: null,
				evaluatorBranch: "legacy", evaluatorPromptKey: null, handoffStep: null,
				attemptKind: "primary", callGroupId: "cg_old", provider: "anthropic",
				outcome: "ok", verdict: "done", confidence: 0.9, reason: "x", followUpMessageLen: 0,
				latencyMs: 100, errorMessage: null, inputTokens: null, outputTokens: null,
				promptSample: null, responseSample: null,
				now: "2026-04-01T00:00:00.000Z",
			});
			broker.control.recordEvaluatorDiagnostic({
				handoffId: "h_new", collabId: "x", chainId: null, workflowId: null, phaseRunId: null,
				evaluatorBranch: "legacy", evaluatorPromptKey: null, handoffStep: null,
				attemptKind: "primary", callGroupId: "cg_new", provider: "anthropic",
				outcome: "ok", verdict: "done", confidence: 0.9, reason: "x", followUpMessageLen: 0,
				latencyMs: 100, errorMessage: null, inputTokens: null, outputTokens: null,
				promptSample: null, responseSample: null,
				now: "2026-05-13T00:00:00.000Z",
			});

			const deleted = broker.control.sweepEvaluatorDiagnostics({
				cutoffIso: "2026-05-01T00:00:00.000Z",
			});
			expect(deleted).toBe(1);

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("x", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.handoffId).toBe("h_new");
		} finally {
			void broker.stop();
		}
	});
});
