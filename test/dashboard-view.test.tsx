import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Wall, gridCapacity } from "../packages/cli/src/runtime/dashboard-view.tsx";
import type { WallState } from "../packages/cli/src/runtime/dashboard-state.ts";
import { Inspector } from "../packages/cli/src/runtime/dashboard-view.tsx";
import type { InspectorState } from "../packages/cli/src/runtime/dashboard-state.ts";

function wall(p: Partial<WallState>): WallState {
	return {
		panes: [
			{ collabId: "c1", workflowId: "wf", header: "oauth  spec-driven-development  P2/4 R3/5", healthLine: "● codex ● claude  Chain active · ALIVE", stuck: false, logTail: [{ kind: "event", isLatest: true, text: "08:21 codex→claude review findings" }] },
			{ collabId: "c2", workflowId: null, header: "Manual  manual relay", healthLine: "⚠ STUCK 5/5 max reached → escalated", stuck: true, logTail: [] },
		],
		page: 0, pageCount: 2, totalRuns: 6, selected: 1, ...p,
	};
}

describe("gridCapacity", () => {
	it("derives cols×rows from terminal size with a min pane floor, ≥1", () => {
		expect(gridCapacity(100, 24)).toBe(Math.max(1, Math.floor(100 / 40)) * Math.max(1, Math.floor(24 / 5)));
		expect(gridCapacity(10, 3)).toBe(1);
	});
});

describe("Wall", () => {
	it("renders pane headers, health, log tail, page indicator", () => {
		const { lastFrame } = render(<Wall state={wall({})} cols={100} rows={24} />);
		const f = lastFrame()!;
		expect(f).toContain("oauth");
		expect(f).toContain("Manual  manual relay");
		expect(f).toContain("⚠ STUCK 5/5");
		expect(f).toContain("review findings");
		expect(f).toContain("page 1/2");
		expect(f).toContain("6 runs");
	});
	it("empty wall shows the no-active state", () => {
		const { lastFrame } = render(<Wall state={wall({ panes: [], pageCount: 0, totalRuns: 0, selected: 0 })} cols={100} rows={24} />);
		expect(lastFrame()!).toContain("no active collabs");
	});
	it("chunks >colsCount panes into multiple rows and renders every pane", () => {
		// cols=100 → colsCount = max(1, floor(100/40)) = 2; 5 panes → 3 rows (2,2,1)
		const panes = Array.from({ length: 5 }, (_, i) => ({
			collabId: `c${i}`,
			workflowId: i === 4 ? null : "wf",
			header: `run-${i}  spec-driven-development  P1/4 R1/5`,
			healthLine: i === 2 ? "⚠ STUCK" : "● codex ● claude  Chain active",
			stuck: i === 2, // pane 2 stuck → red border (not selected)
			logTail: [],
		}));
		// selected = pane 3 (not stuck) → cyan border; pane 2 stuck → red border.
		// (ink-testing-library strips ANSI; border COLOR is set via the
		// borderColor prop and verified visually out of band — here we lock
		// the structural facts: all panes render across multiple rows.)
		const { lastFrame } = render(
			<Wall state={wall({ panes, page: 0, pageCount: 1, totalRuns: 5, selected: 3 })} cols={100} rows={24} />,
		);
		const f = lastFrame()!;
		for (let i = 0; i < 5; i++) expect(f).toContain(`run-${i}`);
		expect(f).toContain("⚠ STUCK"); // the stuck pane rendered
		expect((f.match(/╭/g) ?? []).length).toBe(5); // one rounded box per pane (multi-row)
		expect(f).toContain("page 1/1");
		expect(f).toContain("5 runs");
	});
});

function inspState(): InspectorState {
	return {
		live: { wf: "spec-driven-development  wf…  \"oauth\"", progress: "Phase 2/4 plan-writing · Round 5/5 · Step review", elapsed: "total 14m · phase 11m", turn: "codex · waiting claude · handoff accepted", health: "● codex ● claude  Chain escalated", live: "", why: "STUCK 5/5 max reached → escalated", last: "findings 0.43 · capture ok", stuck: true, logLines: [] },
		timeline: [
			{ phaseIndex: 0, phaseName: "spec-refining", roundsUsed: 2, maxRounds: 5, durationMs: 192000, outcome: "done", estInTokens: 6000, estOutTokens: 3000 },
			{ phaseIndex: 1, phaseName: "plan-writing", roundsUsed: 5, maxRounds: 5, durationMs: 700000, outcome: "escalated", estInTokens: 45000, estOutTokens: 29000 },
		],
		evidence: { phase: "plan-writing", chainId: "ch_7f3", items: [{ round: 5, step: "review", sender: "claude", target: "codex", verdict: "findings", confidence: 0.43, reasonExcerpt: "criterion 5 unmet", captureStatus: "ok" }], diagnostics: [{ kind: "evaluator", text: "verdict findings conf 0.43 · ok · criterion 5 unmet" }], likelyCause: "5/5 rounds, confidence declining → under-specified input" },
		cost: { totalMs: 892000, estInputTokens: 51000, estOutputTokens: 32000, perPhase: [{ phaseRunId: "pr1", phaseName: "spec-refining", estInTokens: 6000, estOutTokens: 3000, durationMs: 192000 }, { phaseRunId: "pr2", phaseName: "plan-writing", estInTokens: 45000, estOutTokens: 29000, durationMs: 700000 }] },
	};
}

describe("Inspector", () => {
	const vp = { offset: 0, follow: true };
	it("Timeline section shows rounds-vs-max, outcome, est tokens, TOTAL", () => {
		const { lastFrame } = render(<Inspector state={inspState()} section="timeline" viewport={vp} cols={100} rows={24} label="oauth" workflowType="spec-driven-development" />);
		const f = lastFrame()!;
		expect(f).toContain("plan-writing");
		expect(f).toContain("5/5");
		expect(f).toContain("escalated");
		expect(f).toMatch(/TOTAL/);
	});
	it("Evidence section shows the chain + likely cause", () => {
		const { lastFrame } = render(<Inspector state={inspState()} section="evidence" viewport={vp} cols={100} rows={24} label="oauth" workflowType="spec-driven-development" />);
		const f = lastFrame()!;
		expect(f).toContain("ch_7f3");
		expect(f).toContain("criterion 5 unmet");
		expect(f).toContain("under-specified input");
	});
	it("Cost section labels the estimate and shows totals", () => {
		const { lastFrame } = render(<Inspector state={inspState()} section="cost" viewport={vp} cols={100} rows={24} label="oauth" workflowType="spec-driven-development" />);
		const f = lastFrame()!;
		expect(f).toContain("est, not metered");
		expect(f).toContain("51000");
	});
	it("Live section renders the RelayView status rows", () => {
		const { lastFrame } = render(<Inspector state={inspState()} section="live" viewport={vp} cols={100} rows={24} label="oauth" workflowType="spec-driven-development" />);
		expect(lastFrame()!).toContain("progress │");
	});
});
