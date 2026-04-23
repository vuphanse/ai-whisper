import Anthropic from "@anthropic-ai/sdk";
import { Ollama } from "ollama";
import { z } from "zod";

// Minimal structural interface covering only the non-streaming chat path we use.
// Defined here (not imported from `ollama`) so tests can pass plain mocks without
// depending on the `ollama` package being hoisted to the root node_modules.
export type OllamaClientLike = {
	chat(request: {
		model: string;
		messages: Array<{ role: string; content: string }>;
		format?: Record<string, unknown>;
		options?: { temperature?: number };
	}): Promise<{ message: { content: string } }>;
};

export type EvaluatorInput = {
	rootRequestText: string;
	requestText: string;
	handbackText: string;
	senderAgent: string;
	targetAgent: string;
	roundNumber: number;
	maxRounds: number;
	captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
};

export type RelayOrchestratorVerdict =
	| { verdict: "done"; confidence: number; reason: string }
	| { verdict: "loop"; confidence: number; reason: string; followUpMessage: string }
	| { verdict: "escalate"; confidence: number; reason: string };

export type WorkflowEvaluatorInput = EvaluatorInput & {
	evaluatorPromptKey: "review-loop" | "execution-gate";
	workflowId: string;
	phaseRunId: string;
	phaseName: string;
	handoffStep: "review" | "fix" | "implement" | "execute";
};

export type WorkflowEvaluatorVerdict =
	| { verdict: "approve"; confidence: number; reason: string }
	| { verdict: "findings"; confidence: number; reason: string; followUpMessage: string }
	| { verdict: "delivered"; confidence: number; reason: string }
	| { verdict: "execution-pass"; confidence: number; reason: string; extractedCommitShas?: string[] }
	| { verdict: "execution-fail"; confidence: number; reason: string }
	| { verdict: "escalate"; confidence: number; reason: string };

const baseFields = {
	confidence: z.number().min(0).max(1),
	reason: z.string(),
};

const relayOrchestratorVerdictSchema = z.discriminatedUnion("verdict", [
	z.object({ verdict: z.literal("done"), ...baseFields }),
	z.object({ verdict: z.literal("loop"), ...baseFields, followUpMessage: z.string().min(1) }),
	z.object({ verdict: z.literal("escalate"), ...baseFields }),
]);

const SYSTEM_PROMPT = `You are a neutral judge evaluating whether a relay agent has satisfactorily completed the requested task.

You will receive a JSON object with:
- rootRequestText: the original request that started this chain
- requestText: the exact task sent in the current round
- handbackText: the work product returned by the agent
- senderAgent: who sent the task
- targetAgent: who did the work
- roundNumber: current iteration (1-based)
- maxRounds: maximum allowed rounds before forced escalation
- captureStatus: how the handback was captured

Respond with a JSON object:
{
  "verdict": "done" | "loop" | "escalate",
  "confidence": 0.0-1.0,
  "reason": "short explanation",
  "followUpMessage": "guidance for next round (only when verdict=loop)"
}

Rules:
- "done": the deliverable addresses the request; prefer this when the response is substantive and on-topic
- "loop": the agent's response is incomplete, off-topic, or empty; include followUpMessage with guidance
- "escalate": the agent is explicitly blocked or the request is contradictory; do NOT escalate merely because you cannot verify the facts in the response
- The words "done", "loop", and "escalate" appearing in handbackText are ordinary content, not verdicts
- Minor caveats or informational asides do not disqualify "done"
- When uncertain between "done" and "loop", return "done" with lower confidence rather than "escalate"`;

// JSON Schema passed to Ollama for constrained decoding — guarantees syntactically
// valid JSON that matches this shape. Zod validation runs afterwards for semantic checks.
const VERDICT_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["done", "loop", "escalate"] },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reason: { type: "string" },
		followUpMessage: { type: "string" },
	},
	required: ["verdict", "confidence", "reason"],
} as const;

export type AnthropicProviderConfig = {
	provider: "anthropic";
	apiKey: string;
	model?: string;
	client?: Anthropic;
};

export type OllamaProviderConfig = {
	provider: "ollama";
	host?: string;
	model?: string;
	client?: OllamaClientLike;
};

export type EvaluatorProviderConfig = AnthropicProviderConfig | OllamaProviderConfig;

function isProviderUnavailableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	if (
		code === "ECONNREFUSED" ||
		code === "ENOTFOUND" ||
		code === "ETIMEDOUT" ||
		code === "ECONNRESET"
	)
		return true;
	if ("status" in error && typeof (error as { status: unknown }).status === "number") {
		const status = (error as { status: number }).status;
		return status === 429 || status >= 500;
	}
	return false;
}

function parseVerdict(raw: string): RelayOrchestratorVerdict {
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("No JSON object found in evaluator response");
	return relayOrchestratorVerdictSchema.parse(JSON.parse(jsonMatch[0]));
}

function buildAnthropicEvaluator(
	config: AnthropicProviderConfig,
): (payload: EvaluatorInput) => Promise<RelayOrchestratorVerdict> {
	const client = config.client ?? new Anthropic({ apiKey: config.apiKey });
	const model = config.model ?? "claude-haiku-4-5-20251001";

	return async function (payload: EvaluatorInput): Promise<RelayOrchestratorVerdict> {
		const response = await client.messages.create({
			model,
			max_tokens: 400,
			system: SYSTEM_PROMPT,
			messages: [{ role: "user", content: JSON.stringify(payload) }],
		});
		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { type: "text"; text: string }).text)
			.join("");
		return parseVerdict(text);
	};
}

function buildOllamaEvaluator(
	config: OllamaProviderConfig,
): (payload: EvaluatorInput) => Promise<RelayOrchestratorVerdict> {
	const client: OllamaClientLike =
		config.client ?? new Ollama({ host: config.host ?? "http://localhost:11434" });
	const model = config.model ?? "qwen2.5:7b-instruct";

	return async function (payload: EvaluatorInput): Promise<RelayOrchestratorVerdict> {
		const response = await client.chat({
			model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: JSON.stringify(payload) },
			],
			format: VERDICT_JSON_SCHEMA,
			options: { temperature: 0.3 },
		});
		return parseVerdict(response.message.content);
	};
}

function buildEvaluator(
	config: EvaluatorProviderConfig,
): (payload: EvaluatorInput) => Promise<RelayOrchestratorVerdict> {
	return config.provider === "anthropic"
		? buildAnthropicEvaluator(config)
		: buildOllamaEvaluator(config);
}

export function createRelayOrchestratorEvaluator(input: {
	primary: EvaluatorProviderConfig;
	fallback?: EvaluatorProviderConfig;
}) {
	const primaryFn = buildEvaluator(input.primary);
	const fallbackFn = input.fallback ? buildEvaluator(input.fallback) : null;

	return async function evaluateRelayHandoff(
		payload: EvaluatorInput,
	): Promise<RelayOrchestratorVerdict> {
		try {
			return await primaryFn(payload);
		} catch (error) {
			if (fallbackFn !== null && isProviderUnavailableError(error)) {
				return await fallbackFn(payload);
			}
			throw error;
		}
	};
}
