import { describe, expect, it } from "vitest";
import { estimateTokens } from "../packages/cli/src/runtime/dashboard-state.ts";
import { buildWallState, selectWallPage } from "../packages/cli/src/runtime/dashboard-state.ts";
import { buildInspectorState } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";
import type { RunCostRow } from "@ai-whisper/broker";
import type { PhaseRunRef, RelayHandoffLogRow } from "../packages/cli/src/runtime/dashboard-state.ts";

describe("estimateTokens", () => {
	it("is ceil(chars / 4), deterministic, zero for empty/negative", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(1)).toBe(1);
		expect(estimateTokens(4)).toBe(1);
		expect(estimateTokens(5)).toBe(2);
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(-10)).toBe(0);
		expect(estimateTokens(Number.NaN)).toBe(0);
	});
});

function sum(p: Partial<CollabSummary>): CollabSummary {
	return {
		collabId: "c", label: "lbl", workflowId: "wf", workflowType: "spec-driven-development",
		workflowStatus: "running", currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
		currentRound: 2, maxRounds: 5, chainStatus: "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [{ agentType: "codex", healthState: "healthy" }, { agentType: "claude", healthState: "healthy" }],
		lastActivityAt: "2026-05-20T00:00:00.000Z", ...p,
	};
}
const emptySnap = { handoffs: [], phaseRuns: [], totalPhases: 4 };

describe("buildWallState", () => {
	it("attention-sorts stuck → active → idle → done, tiebreak lastActivity desc", () => {
		const summaries = [
			sum({ collabId: "done", workflowStatus: "done", chainStatus: "done", lastActivityAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "idle", workflowStatus: null, chainStatus: null, workflowId: null, lastActivityAt: "2026-05-20T00:08:00.000Z" }),
			sum({ collabId: "stuckA", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:07:00.000Z" }),
			sum({ collabId: "stuckB", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:05:00.000Z" }),
		];
		const snapshots = Object.fromEntries(summaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 10, page: 0, selected: 0, snapshots });
		expect(w.panes.map((p) => p.collabId)).toEqual(["stuckB", "stuckA", "active", "idle", "done"]);
		expect(w.totalRuns).toBe(5);
		expect(w.pageCount).toBe(1);
	});

	it("paginates to capacity and clamps page + selected", () => {
		const summaries = Array.from({ length: 5 }, (_, i) =>
			sum({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const snapshots = Object.fromEntries(summaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 2, page: 9, selected: 9, snapshots });
		expect(w.pageCount).toBe(3);
		expect(w.page).toBe(2);
		expect(w.panes).toHaveLength(1);
		expect(w.selected).toBe(0);
	});

	it("projects a visible pane via buildRelayViewState (header/health/logTail)", () => {
		const s = sum({ collabId: "c1", label: "oauth", workflowType: "spec-driven-development", phaseIndex: 1, currentRound: 3, maxRounds: 5 });
		const snapshots = {
			c1: {
				handoffs: [
					{ handoffId: "h1", createdAt: "2026-05-20T00:00:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 3, handoffStep: "review", workflowId: "wf", phaseRunId: "pr1", handbackText: "did x", evaluatorVerdict: "findings", evaluatorConfidence: 0.5, evaluatorReason: "n", lastActivityAt: "2026-05-20T00:00:00.000Z" },
				] as RelayHandoffLogRow[],
				phaseRuns: [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }] as PhaseRunRef[],
				totalPhases: 4,
			},
		};
		const w = buildWallState({ summaries: [s], now: "2026-05-20T00:00:08.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots });
		const p = w.panes[0]!;
		expect(p.header).toContain("oauth");
		expect(p.header).toContain("spec-driven-development");
		expect(p.header).toContain("P2/4");
		expect(p.header).toContain("R3/5");
		expect(p.healthLine.length).toBeGreaterThan(0);
		expect(p.logTail.length).toBeLessThanOrEqual(2);
		expect(p.logTail.every((l) => l.kind === "event")).toBe(true);
	});

	it("manual-relay summary → header says 'manual relay', no P/R", () => {
		const s = sum({ collabId: "m", label: "Manual", workflowId: null, workflowType: null, workflowStatus: null, currentPhaseRunId: null, phaseIndex: null, phaseName: null, currentRound: null, maxRounds: null, chainStatus: null });
		const w = buildWallState({ summaries: [s], now: "2026-05-20T00:00:01.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots: { m: emptySnap } });
		expect(w.panes[0]!.header).toContain("Manual");
		expect(w.panes[0]!.header).toContain("manual relay");
		expect(w.panes[0]!.header).not.toMatch(/P\d+\/\d+/);
	});

	it("empty summaries → empty wall", () => {
		const w = buildWallState({ summaries: [], now: "2026-05-20T00:00:00.000Z", idleThresholdMs: 30000, capacity: 4, page: 0, selected: 0, snapshots: {} });
		expect(w).toMatchObject({ panes: [], page: 0, pageCount: 0, totalRuns: 0, selected: 0 });
	});
});

describe("selectWallPage", () => {
	it("sorts + paginates WITHOUT needing snapshots; returns only the page's summaries", () => {
		const summaries = [
			sum({ collabId: "done", workflowStatus: "done", chainStatus: "done", lastActivityAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "stuckA", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:07:00.000Z" }),
			sum({ collabId: "stuckB", chainStatus: "escalated", lastActivityAt: "2026-05-20T00:05:00.000Z" }),
		];
		const p0 = selectWallPage({ summaries, capacity: 2, page: 0, selected: 0 });
		expect(p0.pageSummaries.map((s) => s.collabId)).toEqual(["stuckB", "stuckA"]);
		expect(p0).toMatchObject({ page: 0, pageCount: 2, totalRuns: 4, selected: 0 });
		const p9 = selectWallPage({ summaries, capacity: 2, page: 9, selected: 9 });
		expect(p9.page).toBe(1);
		expect(p9.pageSummaries.map((s) => s.collabId)).toEqual(["active", "done"]);
		expect(p9.selected).toBe(1);
	});
	it("buildWallState selects the SAME page as selectWallPage (single-sourced)", () => {
		const summaries = Array.from({ length: 5 }, (_, i) =>
			sum({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const sel = selectWallPage({ summaries, capacity: 2, page: 1, selected: 0 });
		const snapshots = Object.fromEntries(sel.pageSummaries.map((s) => [s.collabId, emptySnap]));
		const w = buildWallState({ summaries, now: "2026-05-20T00:10:00.000Z", idleThresholdMs: 30000, capacity: 2, page: 1, selected: 0, snapshots });
		expect(w.panes.map((p) => p.collabId)).toEqual(sel.pageSummaries.map((s) => s.collabId));
	});
	it("treats empty lastActivityAt (fresh running run, no handoffs) as most-recent within its rank", () => {
		const summaries = [
			sum({ collabId: "old", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:01:00.000Z" }),
			sum({ collabId: "fresh", workflowStatus: "running", chainStatus: "active", lastActivityAt: "" }),
		];
		const sel = selectWallPage({ summaries, capacity: 10, page: 0, selected: 0 });
		expect(sel.pageSummaries.map((s) => s.collabId)).toEqual(["fresh", "old"]);
	});
	it("ranks workflowStatus halted/canceled as stuck (the non-chainStatus OR branch)", () => {
		const summaries = [
			sum({ collabId: "active", workflowStatus: "running", chainStatus: "active", lastActivityAt: "2026-05-20T00:09:00.000Z" }),
			sum({ collabId: "halted", workflowStatus: "halted", chainStatus: "active", lastActivityAt: "2026-05-20T00:02:00.000Z" }),
			sum({ collabId: "canceled", workflowStatus: "canceled", chainStatus: "active", lastActivityAt: "2026-05-20T00:05:00.000Z" }),
		];
		const sel = selectWallPage({ summaries, capacity: 10, page: 0, selected: 0 });
		// halted+canceled are stuck (rank 0) → before the active run; among the
		// two stuck, lastActivity desc → canceled (00:05) before halted (00:02).
		expect(sel.pageSummaries.map((s) => s.collabId)).toEqual(["canceled", "halted", "active"]);
	});
});

const liveSnap = {
	now: "2026-05-20T00:15:00.000Z", idleThresholdMs: 30000,
	workflow: { workflowId: "wf", workflowType: "spec-driven-development", name: "x", status: "running" as const, createdAt: "2026-05-20T00:00:00.000Z", haltReason: null },
	phaseRuns: [], currentPhaseRunId: "pr2", currentStep: null, totalPhases: 4,
	chain: { currentRound: 5, maxRounds: 5, status: "escalated" as const },
	turn: { turnOwner: "codex" as const, waitingAgent: "claude" as const, handoffState: "accepted" },
	sessions: [{ agentType: "codex", healthState: "healthy" }], lastActivityAt: "2026-05-20T00:14:00.000Z", handoffs: [],
};

describe("buildInspectorState — timeline + cost", () => {
	it("computes per-phase duration, rounds vs max, est tokens, and totals", () => {
		const phaseRuns: PhaseRunRef[] = [
			{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:03:00.000Z", outcome: "done" },
			{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:03:00.000Z", endedAt: null, outcome: null },
		];
		const costRows: RunCostRow[] = [
			{ phaseRunId: "pr1", createdAt: "2026-05-20T00:00:00.000Z", resolvedAt: "2026-05-20T00:03:00.000Z", lastActivityAt: "2026-05-20T00:03:00.000Z", inChars: 4000, outChars: 800 },
			{ phaseRunId: "pr2", createdAt: "2026-05-20T00:04:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:14:00.000Z", inChars: 8000, outChars: 1200 },
		];
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns, phaseMaxRounds: { 0: 5, 1: 5 }, costRows,
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch1",
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
		});
		expect(s.live.health).toContain("Chain escalated");
		expect(s.timeline).toHaveLength(2);
		expect(s.timeline[0]).toMatchObject({ phaseName: "spec-refining", maxRounds: 5, durationMs: 180000, outcome: "done", estInTokens: 1000, estOutTokens: 200 });
		expect(s.timeline[1]).toMatchObject({ phaseName: "plan-writing", durationMs: null, estInTokens: 2000, estOutTokens: 300 });
		expect(s.cost.estInputTokens).toBe(3000);
		expect(s.cost.estOutputTokens).toBe(500);
		expect(s.cost.totalMs).toBe(Date.parse("2026-05-20T00:14:00.000Z") - Date.parse("2026-05-20T00:00:00.000Z"));
		expect(s.cost.perPhase.map((p) => p.phaseName)).toEqual(["spec-refining", "plan-writing"]);
	});

	it("manual-relay (no workflowCreatedAt) → totalMs from min createdAt; timeline empty", () => {
		const costRows: RunCostRow[] = [
			{ phaseRunId: null, createdAt: "2026-05-20T00:02:00.000Z", resolvedAt: null, lastActivityAt: "2026-05-20T00:06:00.000Z", inChars: 40, outChars: 4 },
		];
		const s = buildInspectorState({
			snapshot: { ...liveSnap, workflow: null }, phaseRuns: [], phaseMaxRounds: {}, costRows,
			workflowCreatedAt: null, chainId: null, evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: null,
		});
		expect(s.timeline).toEqual([]);
		expect(s.cost.totalMs).toBe(Date.parse("2026-05-20T00:06:00.000Z") - Date.parse("2026-05-20T00:02:00.000Z"));
		expect(s.cost.estInputTokens).toBe(10);
	});

	it("no cost rows → zero totals, no NaN", () => {
		const s = buildInspectorState({
			snapshot: liveSnap, phaseRuns: [], phaseMaxRounds: {}, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: null, evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: null,
		});
		expect(s.cost).toMatchObject({ totalMs: 0, estInputTokens: 0, estOutputTokens: 0, perPhase: [] });
	});

	it("roundsUsed = max roundNumber per phaseRun from snapshot.handoffs (null phase/round ignored); maxRounds from phaseMaxRounds", () => {
		const phaseRuns: PhaseRunRef[] = [
			{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining", startedAt: "2026-05-20T00:00:00.000Z", endedAt: "2026-05-20T00:03:00.000Z", outcome: "done" },
			{ phaseRunId: "pr2", phaseIndex: 1, phaseName: "plan-writing", startedAt: "2026-05-20T00:03:00.000Z", endedAt: null, outcome: null },
		];
		const hs = [
			{ handoffId: "a", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 1, handoffStep: "review", workflowId: "wf", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "approve", evaluatorConfidence: 0.9, evaluatorReason: null, lastActivityAt: "2026-05-20T00:01:00.000Z" },
			{ handoffId: "b", createdAt: "2026-05-20T00:02:00.000Z", collabId: "c", senderAgent: "claude", targetAgent: "codex", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 2, handoffStep: "fix", workflowId: "wf", phaseRunId: "pr1", handbackText: "y", evaluatorVerdict: "findings", evaluatorConfidence: 0.4, evaluatorReason: null, lastActivityAt: "2026-05-20T00:02:00.000Z" },
			{ handoffId: "c", createdAt: "2026-05-20T00:05:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch", roundNumber: 4, handoffStep: "review", workflowId: "wf", phaseRunId: "pr2", handbackText: "z", evaluatorVerdict: "findings", evaluatorConfidence: 0.3, evaluatorReason: null, lastActivityAt: "2026-05-20T00:05:00.000Z" },
			{ handoffId: "d", createdAt: "2026-05-20T00:06:00.000Z", collabId: "c", senderAgent: "codex", targetAgent: "claude", status: "pending", captureStatus: null, chainId: null, roundNumber: null, handoffStep: null, workflowId: null, phaseRunId: null, handbackText: null, evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null, lastActivityAt: "2026-05-20T00:06:00.000Z" },
		] as RelayHandoffLogRow[];
		const s = buildInspectorState({
			snapshot: { ...liveSnap, handoffs: hs },
			phaseRuns, phaseMaxRounds: { 0: 5, 1: 3 }, costRows: [],
			workflowCreatedAt: "2026-05-20T00:00:00.000Z", chainId: "ch",
			evidenceHandoffs: [], evaluatorDiags: [], captureDiags: [], focusedPhaseRunId: "pr2",
		});
		expect(s.timeline.map((t) => ({ p: t.phaseName, used: t.roundsUsed, max: t.maxRounds }))).toEqual([
			{ p: "spec-refining", used: 2, max: 5 }, // max(round 1, round 2) for pr1
			{ p: "plan-writing", used: 4, max: 3 },  // round 4 for pr2; null-phase/round handoff "d" ignored
		]);
	});
});
