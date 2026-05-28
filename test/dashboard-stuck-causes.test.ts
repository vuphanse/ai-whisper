import { describe, expect, it } from "vitest";
import {
	buildRelayViewState,
	type RelayViewSnapshot,
} from "../packages/cli/src/runtime/relay-view-state.ts";
import { statusGlyph } from "../packages/cli/src/runtime/dashboard-glyph.ts";
import { THEME } from "../packages/cli/src/runtime/theme.ts";

const BASE_NOW = "2026-05-28T00:10:00.000Z";
const LONG_AGO = "2026-05-28T00:00:00.000Z"; // 10 min idle, past the default 5-min budget

function snap(
	p: Partial<RelayViewSnapshot> & {
		workflowStatus?: "running" | "halted" | "done" | "canceled";
	},
): RelayViewSnapshot {
	const status = p.workflowStatus ?? "running";
	return {
		now: BASE_NOW,
		idleThresholdMs: 60_000,
		workflow: {
			workflowId: "wf",
			workflowType: "complex-bug-fixing",
			name: "demo",
			status,
			createdAt: LONG_AGO,
			haltReason: null,
		},
		phaseRuns: [
			{
				phaseRunId: "pr1",
				phaseIndex: 0,
				phaseName: "plan",
				startedAt: LONG_AGO,
				endedAt: null,
				outcome: null,
			},
		],
		currentPhaseRunId: "pr1",
		currentStep: "review",
		totalPhases: 3,
		chain: { currentRound: 1, maxRounds: 3, status: "active" },
		turn: { turnOwner: "codex", waitingAgent: null, handoffState: "accepted" },
		sessions: [
			{ agentType: "codex", healthState: "healthy", mountAlive: true },
			{ agentType: "claude", healthState: "healthy", mountAlive: true },
		],
		lastActivityAt: LONG_AGO,
		handoffs: [],
		...p,
	};
}

function assertStuckGlyph(rv: ReturnType<typeof buildRelayViewState>): void {
	expect(rv.stuck).toBe(true);
	const result = statusGlyph({
		workflowStatus: "running",
		stuck: rv.stuck,
	});
	expect(result.glyph).toBe("⚠");
	expect(result.color).toBe(THEME.err);
	expect(result.key).toBe("stuck");
}

describe("stuck causes all render the ⚠ glyph in THEME.err", () => {
	it("chain escalated", () => {
		const rv = buildRelayViewState(
			snap({ chain: { currentRound: 1, maxRounds: 3, status: "escalated" } }),
		);
		assertStuckGlyph(rv);
	});

	it("chain abandoned", () => {
		const rv = buildRelayViewState(
			snap({ chain: { currentRound: 1, maxRounds: 3, status: "abandoned" } }),
		);
		assertStuckGlyph(rv);
	});

	it("round-max reached (maxRounds > 1)", () => {
		const rv = buildRelayViewState(
			snap({ chain: { currentRound: 3, maxRounds: 3, status: "active" } }),
		);
		assertStuckGlyph(rv);
	});

	it("provider offline (active session healthState=offline)", () => {
		const rv = buildRelayViewState(
			snap({
				sessions: [
					{ agentType: "codex", healthState: "offline", mountAlive: true },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		assertStuckGlyph(rv);
	});

	it("mount-dead (active session mountAlive=false past idle budget)", () => {
		const rv = buildRelayViewState(
			snap({
				sessions: [
					{ agentType: "codex", healthState: "healthy", mountAlive: false },
					{ agentType: "claude", healthState: "healthy", mountAlive: true },
				],
			}),
		);
		assertStuckGlyph(rv);
	});

	it("workflowStatus=halted maps to ⚠ via statusGlyph directly", () => {
		// Halted is terminal: statusGlyph short-circuits to ⚠ regardless of stuck.
		const result = statusGlyph({ workflowStatus: "halted", stuck: false });
		expect(result.glyph).toBe("⚠");
		expect(result.color).toBe(THEME.err);
		expect(result.key).toBe("stuck");
	});
});
