import { describe, expect, it, vi } from "vitest";
import {
	createRelayOrchestratorEvaluator,
	type EvaluatorInput,
	type OllamaClientLike,
	type WorkflowEvaluatorInput,
} from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

function makePayload(overrides: Partial<EvaluatorInput> = {}): EvaluatorInput {
	return {
		rootRequestText: "Write a report",
		requestText: "Write a report",
		handbackText: "Here is the report: all done.",
		senderAgent: "codex",
		targetAgent: "claude",
		roundNumber: 1,
		maxRounds: 3,
		captureStatus: "ok",
		...overrides,
	};
}

function makeWorkflowPayload(
	overrides: Partial<WorkflowEvaluatorInput> = {},
): WorkflowEvaluatorInput {
	return {
		...makePayload(),
		evaluatorPromptKey: "review-loop",
		workflowId: "wf_1",
		phaseRunId: "pr_1",
		phaseName: "spec-refining",
		handoffStep: "review",
		...overrides,
	};
}

function makeOllamaClient(content: string): OllamaClientLike {
	return {
		chat: vi.fn(() => Promise.resolve({ message: { content } })),
	} as OllamaClientLike;
}

describe("createRelayOrchestratorEvaluator — Ollama provider", () => {
	it("parses a done verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.95, reason: "fully complete" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		const result = await evaluate(makePayload());

		expect(result.verdict).toBe("done");
		expect(result.confidence).toBe(0.95);
	});

	it("parses a loop verdict with followUpMessage", async () => {
		const client = makeOllamaClient(
			JSON.stringify({
				verdict: "loop",
				confidence: 0.8,
				reason: "missing conclusion",
				followUpMessage: "add a conclusion paragraph",
			}),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		const result = await evaluate(makePayload());

		expect(result.verdict).toBe("loop");
		if (result.verdict === "loop") {
			expect(result.followUpMessage).toBe("add a conclusion paragraph");
		}
	});

	it("sends the system prompt and payload as separate messages", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 0.9, reason: "ambiguous" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client, model: "qwen2.5:7b-instruct" },
		});
		const payload = makePayload();

		await evaluate(payload);

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(callArg.messages[0]?.role).toBe("system");
		expect(callArg.messages[1]?.role).toBe("user");
		expect(callArg.messages[1]?.content).toBe(JSON.stringify(payload));
	});

	it("uses qwen2.5:7b-instruct when no model is configured", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		await evaluate(makePayload());

		const callArg = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
			model: string;
		};
		expect(callArg.model).toBe("qwen2.5:7b-instruct");
	});

	it("throws on invalid verdict schema", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "unknown", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });

		await expect(evaluate(makePayload())).rejects.toThrow();
	});
});

describe("createRelayOrchestratorEvaluator — fallback", () => {
	it("falls back to secondary provider on ECONNREFUSED", async () => {
		const networkError = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(networkError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		const result = await evaluate(makePayload());

		expect(result.verdict).toBe("done");
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it("does not fall back on Zod parse errors", async () => {
		const badClient = makeOllamaClient(
			JSON.stringify({ verdict: "not-a-real-verdict", confidence: 0.9, reason: "ok" }),
		);
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: badClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		await expect(evaluate(makePayload())).rejects.toThrow();
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("does not fall back on HTTP 401 auth errors", async () => {
		const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(authError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		await expect(evaluate(makePayload())).rejects.toThrow();
		expect((fallbackClient.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("falls back on HTTP 429 rate limit", async () => {
		const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
		const primaryClient = {
			chat: vi.fn(() => Promise.reject(rateLimitError)),
		} as OllamaClientLike;
		const fallbackClient = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);

		const evaluate = createRelayOrchestratorEvaluator({
			primary: { provider: "ollama", client: primaryClient },
			fallback: { provider: "ollama", client: fallbackClient },
		});

		const result = await evaluate(makePayload());

		expect(result.verdict).toBe("done");
	});
});

// ---------------------------------------------------------------------------
// Workflow path: review step (review-loop, handoffStep="review")
// Allowed verdicts: approve | findings | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow review step", () => {
	it("parses an approve verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "approve", confidence: 0.9, reason: "spec is clear" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "review" }));
		expect(result.verdict).toBe("approve");
	});

	it("parses a findings verdict with followUpMessage", async () => {
		const client = makeOllamaClient(
			JSON.stringify({
				verdict: "findings",
				confidence: 0.85,
				reason: "missing acceptance criteria",
				followUpMessage: "Add acceptance criteria for stdout content and exit code",
			}),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "review" }));
		expect(result.verdict).toBe("findings");
		if (result.verdict === "findings") {
			expect(result.followUpMessage).toContain("acceptance criteria");
		}
	});

	it("parses an escalate verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "contradictory spec" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "review" }));
		expect(result.verdict).toBe("escalate");
	});

	it("rejects a legacy `done` verdict for review step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "done", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(evaluate(makeWorkflowPayload({ handoffStep: "review" }))).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Workflow path: implement / fix step (review-loop, handoffStep="implement"|"fix")
// Allowed verdicts: delivered | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow implement/fix step", () => {
	it("parses a delivered verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.9, reason: "commits made" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "implement" }));
		expect(result.verdict).toBe("delivered");
	});

	it("parses a delivered verdict for fix step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.85, reason: "fix landed" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "fix" }));
		expect(result.verdict).toBe("delivered");
	});

	it("parses an escalate verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "blocked on missing dep" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(makeWorkflowPayload({ handoffStep: "implement" }));
		expect(result.verdict).toBe("escalate");
	});

	it("rejects an approve verdict for implement step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "approve", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(evaluate(makeWorkflowPayload({ handoffStep: "implement" }))).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Workflow path: execute step (execution-gate, handoffStep="execute")
// Allowed verdicts: execution-pass | execution-fail | escalate
// ---------------------------------------------------------------------------

describe("createRelayOrchestratorEvaluator — workflow execute step", () => {
	it("parses an execution-pass verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "execution-pass", confidence: 0.95, reason: "tests pass" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(
			makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
		);
		expect(result.verdict).toBe("execution-pass");
	});

	it("parses an execution-fail verdict", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "execution-fail", confidence: 0.9, reason: "tests failed" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(
			makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
		);
		expect(result.verdict).toBe("execution-fail");
	});

	it("parses an escalate verdict for execute step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "escalate", confidence: 1, reason: "infra missing" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		const result = await evaluate(
			makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
		);
		expect(result.verdict).toBe("escalate");
	});

	it("rejects a delivered verdict for execute step", async () => {
		const client = makeOllamaClient(
			JSON.stringify({ verdict: "delivered", confidence: 0.9, reason: "ok" }),
		);
		const evaluate = createRelayOrchestratorEvaluator({ primary: { provider: "ollama", client } });
		await expect(
			evaluate(
				makeWorkflowPayload({ evaluatorPromptKey: "execution-gate", handoffStep: "execute" }),
			),
		).rejects.toThrow();
	});
});
