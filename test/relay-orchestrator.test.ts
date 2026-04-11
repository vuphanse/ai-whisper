import { describe, expect, it, vi } from "vitest";
import { createRelayOrchestrator } from "../packages/cli/src/runtime/relay-orchestrator.ts";
import type { RelayHandoffRecord } from "../packages/broker/src/storage/repositories/relay-handoff-repository.ts";

function makeHandedBack(overrides: Partial<RelayHandoffRecord> = {}): RelayHandoffRecord {
	return {
		handoffId: "handoff_1",
		collabId: "collab_chain",
		senderAgent: "codex",
		targetAgent: "claude",
		requestText: "do the thing",
		status: "handed_back",
		captureStatus: "ok",
		chainId: "handoff_1",
		parentHandoffId: null,
		roundNumber: 1,
		maxRounds: 3,
		rootRequestText: "do the thing",
		handbackText: "done",
		orchestratorStatus: "idle",
		orchestratorVerdict: null,
		orchestratorReason: null,
		orchestratorClaimedAt: null,
		orchestratorEvaluatedAt: null,
		createdAt: "2026-04-11T00:00:00.000Z",
		acceptedAt: "2026-04-11T00:00:10.000Z",
		deferredAt: null,
		resolvedAt: null,
		lastActivityAt: "2026-04-11T00:01:00.000Z",
		...overrides,
	};
}

function makeBrokerDouble(options: { claimable: RelayHandoffRecord[] }) {
	const { claimable } = options;
	let listCalled = false;
	let claimIndex = 0;

	return {
		control: {
			listRelayHandoffsPendingOrchestration: vi.fn(() => {
				if (!listCalled) {
					listCalled = true;
					return claimable;
				}
				return [];
			}),
			claimRelayHandoffForOrchestration: vi.fn(() => {
				const item = claimable[claimIndex++] ?? null;
				if (!item) return null;
				return { ...item, orchestratorStatus: "pending" as const };
			}),
			createLoopRelayHandoff: vi.fn(),
			markRelayChainEscalated: vi.fn(),
			resolveRelayChain: vi.fn(),
			markRelayChainAbandoned: vi.fn(),
			cleanupOrchestration: vi.fn(),
		},
	};
}

describe("relay orchestrator", () => {
	it("re-issues the prior request unchanged when captureStatus=no_response_captured", async () => {
		const broker = makeBrokerDouble({
			claimable: [
				makeHandedBack({
					handoffId: "handoff_1",
					requestText: "Review spec",
					captureStatus: "no_response_captured",
				}),
			],
		});
		const evaluate = vi.fn();

		const orchestrator = createRelayOrchestrator({
			broker,
			collabId: "collab_chain",
			evaluate,
			createHandoffId: () => "handoff_2",
		});

		await orchestrator.pollOnce();

		expect(evaluate).not.toHaveBeenCalled();
		expect(broker.control.createLoopRelayHandoff).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				nextHandoffId: "handoff_2",
				requestText: "Review spec",
			}),
		);
	});

	it("escalates when evaluator confidence is below 0.5", async () => {
		const broker = makeBrokerDouble({ claimable: [makeHandedBack()] });
		const evaluate = vi.fn(() =>
			Promise.resolve({
				verdict: "loop" as const,
				confidence: 0.2,
				reason: "ambiguous",
				followUpMessage: "try again",
			}),
		);

		const orchestrator = createRelayOrchestrator({ broker, collabId: "collab_chain", evaluate });
		await orchestrator.pollOnce();

		expect(broker.control.markRelayChainEscalated).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				reason: expect.stringContaining("ambiguous") as string,
			}),
		);
	});

	it("escalates without calling evaluator when roundNumber already reached maxRounds", async () => {
		const broker = makeBrokerDouble({
			claimable: [makeHandedBack({ roundNumber: 3, maxRounds: 3 })],
		});
		const evaluate = vi.fn();

		const orchestrator = createRelayOrchestrator({ broker, collabId: "collab_chain", evaluate });
		await orchestrator.pollOnce();

		expect(evaluate).not.toHaveBeenCalled();
		expect(broker.control.markRelayChainEscalated).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				reason: expect.stringContaining("max rounds") as string,
			}),
		);
	});

	it("retries evaluator once, then escalates when both attempts throw", async () => {
		const broker = makeBrokerDouble({ claimable: [makeHandedBack()] });
		const evaluate = vi
			.fn()
			.mockRejectedValueOnce(new Error("upstream timeout"))
			.mockRejectedValueOnce(new Error("upstream timeout"));

		const orchestrator = createRelayOrchestrator({ broker, collabId: "collab_chain", evaluate });
		await orchestrator.pollOnce();

		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(broker.control.markRelayChainEscalated).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				reason: expect.stringContaining("LLM evaluation failed after retry") as string,
			}),
		);
	});

	it("escalates when evaluator returns verdict=escalate directly", async () => {
		const broker = makeBrokerDouble({ claimable: [makeHandedBack()] });
		const evaluate = vi.fn(() =>
			Promise.resolve({
				verdict: "escalate" as const,
				confidence: 0.9,
				reason: "response is contradictory",
			}),
		);

		const orchestrator = createRelayOrchestrator({ broker, collabId: "collab_chain", evaluate });
		await orchestrator.pollOnce();

		expect(broker.control.markRelayChainEscalated).toHaveBeenCalledWith(
			expect.objectContaining({
				handoffId: "handoff_1",
				reason: "response is contradictory",
			}),
		);
	});
});
