import type { EvaluatorInput, RelayOrchestratorVerdict } from "./relay-orchestrator-evaluator.ts";

type BrokerLike = {
	control: {
		listRelayHandoffsPendingOrchestration: (collabId: string) => Array<{
			handoffId: string;
			requestText: string;
			captureStatus: string | null;
			roundNumber: number | null;
			maxRounds: number;
			rootRequestText: string | null;
			handbackText: string | null;
			senderAgent: string;
			targetAgent: string;
		}>;
		claimRelayHandoffForOrchestration: (input: {
			handoffId: string;
			claimedAt: string;
		}) => {
			handoffId: string;
			captureStatus: string | null;
			roundNumber: number | null;
			maxRounds: number;
			requestText: string;
			rootRequestText: string | null;
			handbackText: string | null;
			senderAgent: string;
			targetAgent: string;
		} | null;
		createLoopRelayHandoff: (input: {
			handoffId: string;
			nextHandoffId: string;
			requestText: string;
			reason: string;
			now: string;
		}) => unknown;
		resolveRelayChain: (input: {
			handoffId: string;
			reason: string;
			evaluatedAt: string;
		}) => void;
		markRelayChainEscalated: (input: {
			handoffId: string;
			reason: string;
			evaluatedAt: string;
		}) => void;
	};
};

function composeLoopRequest(input: {
	rootRequestText: string;
	handbackText: string;
	followUpMessage: string;
}): string {
	return `Original request:\n${input.rootRequestText}\n\nLatest result:\n${input.handbackText}\n\nFollow-up:\n${input.followUpMessage}`;
}

type ClaimedHandoff = NonNullable<
	ReturnType<BrokerLike["control"]["claimRelayHandoffForOrchestration"]>
>;

function buildEvaluatorInput(claimed: ClaimedHandoff): EvaluatorInput {
	return {
		rootRequestText: claimed.rootRequestText ?? claimed.requestText,
		requestText: claimed.requestText,
		handbackText: claimed.handbackText ?? "",
		senderAgent: claimed.senderAgent,
		targetAgent: claimed.targetAgent,
		roundNumber: claimed.roundNumber ?? 1,
		maxRounds: claimed.maxRounds,
		captureStatus: claimed.captureStatus as EvaluatorInput["captureStatus"],
	};
}

export function createRelayOrchestrator(input: {
	broker: BrokerLike;
	collabId: string;
	evaluate: (payload: EvaluatorInput) => Promise<RelayOrchestratorVerdict>;
	pollIntervalMs?: number;
	clock?: () => string;
	createHandoffId?: () => string;
	logger?: Pick<Console, "error" | "warn">;
}) {
	const now = input.clock ?? (() => new Date().toISOString());
	const createHandoffId = input.createHandoffId ?? (() => crypto.randomUUID());

	let intervalHandle: ReturnType<typeof setInterval> | null = null;

	async function evaluateWithRetry(payload: EvaluatorInput): Promise<RelayOrchestratorVerdict> {
		try {
			return await input.evaluate(payload);
		} catch (firstError) {
			input.logger?.warn?.("relay orchestrator evaluator failed; retrying once", firstError);
			return await input.evaluate(payload);
		}
	}

	async function pollOnce(): Promise<void> {
		const handoffs = input.broker.control.listRelayHandoffsPendingOrchestration(input.collabId);
		for (const handoff of handoffs) {
			const claimed = input.broker.control.claimRelayHandoffForOrchestration({
				handoffId: handoff.handoffId,
				claimedAt: now(),
			});
			if (!claimed) continue;

			// Forced re-issue: no usable handback — skip LLM
			if (
				claimed.captureStatus === "no_response_captured" ||
				claimed.captureStatus === "no_response_captured_confidently"
			) {
				input.broker.control.createLoopRelayHandoff({
					handoffId: claimed.handoffId,
					nextHandoffId: createHandoffId(),
					requestText: claimed.requestText,
					reason: `forced re-issue: ${claimed.captureStatus}`,
					now: now(),
				});
				continue;
			}

			const roundNumber = claimed.roundNumber ?? 1;

			// Pre-LLM max-round enforcement
			if (roundNumber >= claimed.maxRounds) {
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: `max rounds reached (${roundNumber}/${claimed.maxRounds})`,
					evaluatedAt: now(),
				});
				continue;
			}

			// LLM evaluation with one retry
			let verdict: RelayOrchestratorVerdict;
			try {
				verdict = await evaluateWithRetry(buildEvaluatorInput(claimed));
			} catch (error) {
				input.logger?.error?.("relay orchestrator evaluator failed after retry", error);
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: "LLM evaluation failed after retry",
					evaluatedAt: now(),
				});
				continue;
			}

			// Low-confidence escalation
			if (verdict.confidence < 0.5) {
				input.broker.control.markRelayChainEscalated({
					handoffId: claimed.handoffId,
					reason: verdict.reason,
					evaluatedAt: now(),
				});
				continue;
			}

			if (verdict.verdict === "done") {
				input.broker.control.resolveRelayChain({
					handoffId: claimed.handoffId,
					reason: verdict.reason,
					evaluatedAt: now(),
				});
				continue;
			}

			if (verdict.verdict === "loop") {
				input.broker.control.createLoopRelayHandoff({
					handoffId: claimed.handoffId,
					nextHandoffId: createHandoffId(),
					requestText: composeLoopRequest({
						rootRequestText: claimed.rootRequestText ?? claimed.requestText,
						handbackText: claimed.handbackText ?? "",
						followUpMessage: verdict.followUpMessage!,
					}),
					reason: verdict.reason,
					now: now(),
				});
				continue;
			}

			// verdict === "escalate" or any unrecognized verdict
			input.broker.control.markRelayChainEscalated({
				handoffId: claimed.handoffId,
				reason: verdict.reason,
				evaluatedAt: now(),
			});
		}
	}

	function start(): void {
		const intervalMs = input.pollIntervalMs ?? 1000;
		intervalHandle = setInterval(() => {
			pollOnce().catch((err) => {
				input.logger?.error?.("relay orchestrator poll error", err);
			});
		}, intervalMs);
	}

	async function stop(): Promise<void> {
		if (intervalHandle !== null) {
			clearInterval(intervalHandle);
			intervalHandle = null;
		}
	}

	return { pollOnce, start, stop };
}
