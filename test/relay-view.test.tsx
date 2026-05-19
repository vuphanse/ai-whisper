import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { RelayView } from "../packages/cli/src/runtime/relay-view.tsx";
import type { RelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";

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
