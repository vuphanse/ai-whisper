import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { RelayView } from "../packages/cli/src/runtime/relay-view.tsx";
import type { RelayViewState, LogLine } from "../packages/cli/src/runtime/relay-view-state.ts";

describe("ink toolchain", () => {
	it("renders JSX via ink-testing-library", () => {
		const { lastFrame } = render(<Text>hello-ink</Text>);
		expect(lastFrame()).toContain("hello-ink");
	});
});

const state: RelayViewState = {
	wf: 'spec-driven-development  wf_048c…  "slugify"',
	progress: "Phase 3/4 plan-execution · Round 1/1 · Step execute",
	elapsed: "total 7m12s · phase 2m08s",
	turn: "codex · waiting claude · handoff accepted",
	health: "● codex  ● claude  Chain active · ALIVE",
	live: "idle 8s · auto-handback in 22s",
	why: null,
	last: "delivered 0.95 · capture ok",
	stuck: false,
	logLines: [],
};

describe("RelayView status block", () => {
	it("renders all seven aligned rows with the right-aligned gutter", () => {
		const { lastFrame } = render(
			<RelayView state={state} viewport={{ offset: 0, follow: true }} rows={24} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("wf │ spec-driven-development");
		expect(f).toContain("progress │ Phase 3/4 plan-execution");
		expect(f).toContain("elapsed │ total 7m12s");
		expect(f).toContain("turn │ codex · waiting claude");
		expect(f).toContain("health │ ● codex");
		expect(f).toContain("live │ idle 8s · auto-handback in 22s");
		expect(f).toContain("last │ delivered 0.95 · capture ok");
	});

	it("replaces the live row with a ⚠ why row when stuck", () => {
		const { lastFrame } = render(
			<RelayView
				state={{ ...state, stuck: true, why: "STUCK 3m02s — round 5/5 max reached → escalated" }}
				viewport={{ offset: 0, follow: true }} rows={24} cols={100}
			/>,
		);
		const f = lastFrame()!;
		expect(f).toContain("⚠ why │ STUCK 3m02s — round 5/5");
		expect(f).not.toContain("live │");
	});

	it("stuck with why=null falls back to the live row (documented sentinel)", () => {
		const { lastFrame } = render(
			<RelayView
				state={{ ...state, stuck: true, why: null }}
				viewport={{ offset: 0, follow: true }} rows={24} cols={100}
			/>,
		);
		const f = lastFrame()!;
		expect(f).toContain("live │ idle 8s · auto-handback in 22s");
		expect(f).not.toContain("⚠ why");
	});

	it("non-stuck with a why set still shows live, ignores why", () => {
		const { lastFrame } = render(
			<RelayView
				state={{ ...state, stuck: false, why: "should be ignored" }}
				viewport={{ offset: 0, follow: true }} rows={24} cols={100}
			/>,
		);
		const f = lastFrame()!;
		expect(f).toContain("live │ idle 8s");
		expect(f).not.toContain("should be ignored");
		expect(f).not.toContain("⚠ why");
	});

	it("stuck hides the live content entirely (robust: assert the live value absent)", () => {
		const { lastFrame } = render(
			<RelayView
				state={{ ...state, stuck: true, why: "STUCK 3m02s — round 5/5 max reached → escalated" }}
				viewport={{ offset: 0, follow: true }} rows={24} cols={100}
			/>,
		);
		const f = lastFrame()!;
		expect(f).toContain("⚠ why │ STUCK 3m02s — round 5/5");
		expect(f).not.toContain(state.live); // the live string never appears when stuck
	});

	it("renders a dead provider dot in a red health row when stuck", () => {
		const { lastFrame } = render(
			<RelayView
				state={{ ...state, stuck: true, why: "STUCK — provider unhealthy",
					health: "●(dead) codex  ● claude  Chain stuck" }}
				viewport={{ offset: 0, follow: true }} rows={24} cols={100}
			/>,
		);
		const f = lastFrame()!;
		expect(f).toContain("health │ ●(dead) codex");
	});
});

const logLines: LogLine[] = [
	{ kind: "phase-rule", text: "── phase 2/4 · plan-writing ──" },
	{ kind: "event", isLatest: false, text: "08:21:03  P2·R1  codex→claude  implement  delivered  a" },
	{ kind: "event", isLatest: false, text: "08:21:40  P2·R1  claude→codex  review     findings   b" },
	{ kind: "phase-summary", ok: true, text: "✔ plan-writing — 2 rounds (4 handovers) · 3m12s → approve" },
	{ kind: "event", isLatest: true, text: "08:22:55  P3·R1  codex→claude  execute    running…" },
];

describe("RelayView log viewport", () => {
	it("follow-tail shows the newest window and tags the latest line", () => {
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines }} viewport={{ offset: 0, follow: true }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("08:22:55  P3·R1");
		expect(f).toContain("◀ LATEST");
	});

	it("scrolled (follow=false) shows an older window and no LATEST tag", () => {
		const many: LogLine[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "event", isLatest: i === 49, text: `08:00:${String(i).padStart(2, "0")}  line${i}`,
		}));
		// 50 lines; viewport height h = max(3, rows-STATUS_ROWS) = max(3, 20-9) = 11.
		// tail-start = 50-11 = 39. offset = lines scrolled UP from tail →
		// start = max(0, 39 - 29) = 10, so the window is line10…line20.
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines: many }} viewport={{ offset: 29, follow: false }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("line10"); // window starts at line10 (older window)
		expect(f).not.toContain("line49"); // the tail is excluded
		expect(f).not.toContain("◀ LATEST");
	});

	it("re-render with grown lines does not duplicate prior lines", () => {
		const { lastFrame, rerender } = render(
			<RelayView state={{ ...state, logLines: logLines.slice(0, 2) }} viewport={{ offset: 0, follow: true }} rows={20} cols={100} />,
		);
		rerender(
			<RelayView state={{ ...state, logLines }} viewport={{ offset: 0, follow: true }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f.match(/08:21:03 {2}P2·R1/g)?.length ?? 0).toBe(1);
	});

	it("colorFor red branch: a failed phase-summary line still renders its text", () => {
		const withFail: LogLine[] = [
			{ kind: "event", isLatest: false, text: "08:21:03  P2·R1  codex→claude  implement  delivered  a" },
			{ kind: "phase-summary", ok: false, text: "✖ plan-writing — escalated (max rounds)" },
			{ kind: "event", isLatest: true, text: "08:30:00  P2·R5  codex→claude  escalate" },
		];
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines: withFail }} viewport={{ offset: 0, follow: true }} rows={20} cols={100} />,
		);
		expect(lastFrame()!).toContain("✖ plan-writing — escalated (max rounds)");
	});

	it("follow=false at offset 0 shows the tail window but NO ◀ LATEST", () => {
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines }} viewport={{ offset: 0, follow: false }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("08:22:55  P3·R1"); // tail line is visible
		expect(f).not.toContain("◀ LATEST"); // but the tag is gated on follow
	});

	it("offset larger than the buffer clamps to the top window", () => {
		const many: LogLine[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "event", isLatest: i === 49, text: `08:00:${String(i).padStart(2, "0")}  line${i}`,
		}));
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines: many }} viewport={{ offset: 999, follow: false }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("line0"); // clamped to the top of the buffer
		expect(f).not.toContain("line49"); // not the tail
	});

	it("empty logLines renders the status block with no log rows and no crash", () => {
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines: [] }} viewport={{ offset: 0, follow: true }} rows={20} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("wf │"); // status block still renders
		expect(f).not.toContain("◀ LATEST");
	});

	it("rows below STATUS_ROWS floors the viewport to 3 lines without negative slicing", () => {
		const { lastFrame } = render(
			<RelayView state={{ ...state, logLines }} viewport={{ offset: 0, follow: true }} rows={5} cols={100} />,
		);
		const f = lastFrame()!;
		expect(f).toContain("08:22:55  P3·R1"); // h=max(3,5-9)=3 → tail 3 lines, latest visible
		expect(f).toContain("◀ LATEST");
	});
});
