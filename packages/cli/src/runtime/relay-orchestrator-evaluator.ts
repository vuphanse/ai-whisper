import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

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

export type RelayOrchestratorVerdict = {
	verdict: "done" | "loop" | "escalate";
	confidence: number;
	reason: string;
	followUpMessage?: string;
};

const relayOrchestratorVerdictSchema = z.object({
	verdict: z.enum(["done", "loop", "escalate"]),
	confidence: z.number().min(0).max(1),
	reason: z.string(),
	followUpMessage: z.string().optional(),
});

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
- "done": the deliverable fully satisfies the request
- "loop": the agent needs another pass; include followUpMessage
- "escalate": ambiguous, contradictory, or cannot be evaluated`;

export function createRelayOrchestratorEvaluator(input: {
	apiKey: string;
	model?: string;
	client?: Anthropic;
}) {
	const client =
		input.client ??
		new Anthropic({
			apiKey: input.apiKey,
		});

	return async function evaluateRelayHandoff(
		payload: EvaluatorInput,
	): Promise<RelayOrchestratorVerdict> {
		const response = await client.messages.create({
			model: input.model ?? "claude-haiku-4-5-20251001",
			max_tokens: 400,
			system: SYSTEM_PROMPT,
			messages: [{ role: "user", content: JSON.stringify(payload) }],
		});

		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { type: "text"; text: string }).text)
			.join("");
		return relayOrchestratorVerdictSchema.parse(JSON.parse(text));
	};
}
