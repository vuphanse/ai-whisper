import { describe, expect, it } from "vitest";
import { estimateTokens } from "../packages/cli/src/runtime/dashboard-state.ts";
import { buildWallState, selectWallPage } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";
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
