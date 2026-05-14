import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { buildEvaluatorObserverCallback } from "../packages/cli/src/runtime/evaluator-observer.ts";
import type { EvaluatorCallEvent } from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-eval-obs-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4604 });
}

function sampleEvent(overrides: Partial<EvaluatorCallEvent> = {}): EvaluatorCallEvent {
	return {
		callGroupId: "cg_test",
		context: {
			handoffId: "h_1",
			collabId: "collab_1",
			chainId: "chain_1",
			workflowId: null,
			phaseRunId: null,
		},
		branch: "legacy",
		provider: "anthropic",
		attemptKind: "primary",
		outcome: "ok",
		latencyMs: 500,
		rawResponse: "{\"verdict\":\"done\",...}",
		error: null,
		verdict: { verdict: "done", confidence: 0.9, reason: "ok" },
		inputTokens: 412,
		outputTokens: 64,
		systemPrompt: "system prompt body",
		payload: {
			rootRequestText: "x", requestText: "x", handbackText: "x",
			senderAgent: "codex", targetAgent: "claude",
			roundNumber: 1, maxRounds: 3, captureStatus: "ok",
		},
		...overrides,
	};
}

describe("evaluator observer callback", () => {
	it("writes a diagnostic row with all the right fields on success", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent());

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				handoffId: "h_1",
				outcome: "ok",
				verdict: "done",
				provider: "anthropic",
				attemptKind: "primary",
				callGroupId: "cg_test",
				inputTokens: 412,
				outputTokens: 64,
			});
		} finally {
			void broker.stop();
		}
	});

	it("writes NULL samples when AI_WHISPER_NO_EVAL_SAMPLES=1", () => {
		const broker = newBroker();
		const prior = process.env["AI_WHISPER_NO_EVAL_SAMPLES"];
		process.env["AI_WHISPER_NO_EVAL_SAMPLES"] = "1";
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent());

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.promptSample).toBeNull();
			expect(rows[0]?.responseSample).toBeNull();
			expect(rows[0]?.outcome).toBe("ok");
			expect(rows[0]?.inputTokens).toBe(412);
		} finally {
			void broker.stop();
			if (prior === undefined) delete process.env["AI_WHISPER_NO_EVAL_SAMPLES"];
			else process.env["AI_WHISPER_NO_EVAL_SAMPLES"] = prior;
		}
	});

	it("truncates samples to 500 chars", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			const longResponse = "x".repeat(2000);
			const longSystemPrompt = "y".repeat(2000);
			cb(sampleEvent({ rawResponse: longResponse, systemPrompt: longSystemPrompt }));

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.responseSample?.length).toBe(500);
			expect(rows[0]?.promptSample?.length).toBe(500);
		} finally {
			void broker.stop();
		}
	});

	it("does NOT throw when the broker control method throws", () => {
		const broker = newBroker();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			vi.spyOn(broker.control, "recordEvaluatorDiagnostic").mockImplementation(() => {
				throw new Error("sqlite write failed");
			});
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });

			expect(() => cb(sampleEvent())).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("evaluator diagnostic write failed"),
			);
		} finally {
			void broker.stop();
			warnSpy.mockRestore();
		}
	});

	it("captures follow_up_message_len for loop verdict", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent({
				verdict: { verdict: "loop", confidence: 0.5, reason: "incomplete", followUpMessage: "please retry with more detail" },
			}));

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.verdict).toBe("loop");
			expect(rows[0]?.followUpMessageLen).toBe("please retry with more detail".length);
		} finally {
			void broker.stop();
		}
	});

	it("writes NULL verdict/confidence/reason when outcome is not ok", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent({
				outcome: "provider_unavailable",
				verdict: null,
				rawResponse: null,
				error: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
			}));

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.outcome).toBe("provider_unavailable");
			expect(rows[0]?.verdict).toBeNull();
			expect(rows[0]?.confidence).toBeNull();
			expect(rows[0]?.reason).toBeNull();
			expect(rows[0]?.errorMessage).toContain("ECONNREFUSED");
			expect(rows[0]?.responseSample).toBeNull();
		} finally {
			void broker.stop();
		}
	});

	it("populates evaluator_prompt_key + handoff_step from workflow payloads", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent({
				branch: "review",
				payload: {
					rootRequestText: "x", requestText: "x", handbackText: "x",
					senderAgent: "codex", targetAgent: "claude",
					roundNumber: 1, maxRounds: 3, captureStatus: "ok",
					evaluatorPromptKey: "review-loop",
					workflowId: "wf_1",
					phaseRunId: "pr_1",
					phaseName: "spec-refining",
					handoffStep: "review",
				},
				context: {
					handoffId: "h_wf", collabId: "collab_1", chainId: "chain_wf",
					workflowId: "wf_1", phaseRunId: "pr_1",
				},
			}));

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.evaluatorPromptKey).toBe("review-loop");
			expect(rows[0]?.handoffStep).toBe("review");
			expect(rows[0]?.workflowId).toBe("wf_1");
			expect(rows[0]?.phaseRunId).toBe("pr_1");
		} finally {
			void broker.stop();
		}
	});

	it("leaves evaluator_prompt_key + handoff_step NULL for legacy (non-workflow) payloads", () => {
		const broker = newBroker();
		try {
			const cb = buildEvaluatorObserverCallback({ broker, now: () => "2026-05-14T12:00:00.000Z" });
			cb(sampleEvent());

			const rows = broker.control.listEvaluatorDiagnosticsByCollab("collab_1", 10);
			expect(rows[0]?.evaluatorPromptKey).toBeNull();
			expect(rows[0]?.handoffStep).toBeNull();
		} finally {
			void broker.stop();
		}
	});
});
