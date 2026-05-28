import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
	Wall,
	gridCapacity,
	Inspector,
} from "../packages/cli/src/runtime/dashboard-view.tsx";
import type {
	InspectorState,
	PhaseStat,
	WallPaneState,
	WallState,
	WorkflowHistoryItem,
} from "../packages/cli/src/runtime/dashboard-state.ts";
import type { RelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { Viewport } from "../packages/cli/src/runtime/relay-view.ts";
import { readFileSync } from "node:fs";

// ---- Shared Wall fixture helpers (Tasks 8-12) ----

type PaneOverrides = Partial<WallPaneState> & {
	collabId: string;
	statusKey: WallPaneState["statusKey"];
};

function mkPane(p: PaneOverrides): WallPaneState {
	return {
		workflowId: "wf1",
		label: "lbl",
		workflowType: "complex-bug-fixing",
		round: { current: 1, max: 3 },
		progress: { current: 2, total: 5 },
		agentHealth: [
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		],
		stuckWhy: null,
		events: [
			{ step: "review", route: "codex→claude", verdict: "pass" },
			{ step: "execute", route: "claude→codex", verdict: "-" },
		],
		elapsed: "1m23s",
		cardKind: "full",
		...p,
	};
}

type SectionInput = {
	group: WallState["sections"][number]["group"];
	label?: string;
	cardKind?: "full" | "compact";
	panes: WallPaneState[];
};

function mkSection(input: SectionInput): WallState["sections"][number] {
	const cardKind = input.cardKind ?? (input.group === "active" ? "full" : "compact");
	const groupLabels: Record<WallState["sections"][number]["group"], string> = {
		active: "ACTIVE",
		idleManual: "IDLE / MANUAL",
		halted: "HALTED",
		doneCanceled: "DONE / CANCELED",
	};
	const label = input.label ?? `${groupLabels[input.group]} (${input.panes.length})`;
	return { group: input.group, label, cardKind, panes: input.panes };
}

function mkWallState(input: {
	sections?: WallState["sections"];
	selected?: number;
	page?: number;
	pageCount?: number;
	totalRuns?: number;
}): WallState {
	const sections = input.sections ?? [];
	const panes = sections.flatMap((s) => s.panes);
	const totalRuns = input.totalRuns ?? panes.length;
	return {
		sections,
		panes,
		page: input.page ?? 0,
		pageCount: input.pageCount ?? 1,
		totalRuns,
		selected: input.selected ?? 0,
	};
}

function stripAnsi(s: string): string {
	// ESC [ ... letter — drop SGR codes so text-content assertions can match.
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

// ---- Shared Inspector fixture helpers (Task 13) ----

const defaultViewport: Viewport = { offset: 0, follow: true };

function mkLive(p: Partial<RelayViewState> = {}): RelayViewState {
	return {
		wf: 'complex-bug-fixing  wf123…  "demo"',
		progress: "Phase 2/5 plan-writing · Round 1/3 · Step review",
		elapsed: "total 1m23s · phase 0m45s",
		turn: "codex · waiting claude · handoff accepted",
		health: "● codex  ● claude  Chain active · ALIVE",
		agentHealth: [
			{ agent: "codex", health: "healthy" },
			{ agent: "claude", health: "healthy" },
		],
		live: "idle 5s",
		why: null,
		last: "approve 0.92 · capture ok",
		stuck: false,
		logLines: [],
		...p,
	};
}

function mkInspectorState(p: {
	stuck: boolean;
	timeline?: PhaseStat[];
	workflowHistory?: WorkflowHistoryItem[];
}): InspectorState {
	return {
		live: mkLive({
			stuck: p.stuck,
			why: p.stuck ? "STUCK 6m12s — round 3/3 max reached → escalated" : null,
		}),
		timeline: p.timeline ?? [
			{
				phaseIndex: 0,
				phaseName: "plan",
				roundsUsed: 1,
				maxRounds: 3,
				durationMs: 60_000,
				outcome: "approve",
				estInTokens: 100,
				estOutTokens: 50,
			},
		],
		workflowHistory: p.workflowHistory ?? [],
		evidence: {
			phase: "plan",
			chainId: "chain-1",
			items: [],
			diagnostics: [],
			likelyCause: "no blocking signal — run progressing",
		},
		cost: { totalMs: 60_000, estInputTokens: 100, estOutputTokens: 50, perPhase: [] },
	};
}

describe("gridCapacity", () => {
	it("derives cols×rows from terminal size with a min pane floor, ≥1", () => {
		expect(gridCapacity(100, 24)).toBe(
			Math.max(1, Math.floor(100 / 40)) * Math.max(1, Math.floor(24 / 5)),
		);
		expect(gridCapacity(10, 3)).toBe(1);
	});
});

describe("Wall — theme migration (Task 8)", () => {
	it("uses no raw cyan/magenta literals in dashboard-view source", () => {
		const src = readFileSync("packages/cli/src/runtime/dashboard-view.tsx", "utf8");
		expect(src).not.toMatch(/"cyan"|"magenta"/);
	});

	it("Wall pane uses single-style borders", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [mkPane({ collabId: "c1", statusKey: "running" })],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = lastFrame() ?? "";
		expect(out).toMatch(/[┌┐└┘]/);
		expect(out).not.toMatch(/[╭╮╰╯]/);
	});
});

describe("Wall — full ACTIVE card (Task 9)", () => {
	it("full ACTIVE card renders chevron, glyph, label, dimmed type, round, progress bar, and agent dots", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
			selected: 0,
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("▸ ● mylabel");
		expect(out).toContain("complex-bug-fixing");
		expect(out).toContain("R1/3");
		expect(out).toContain("P2/5");
		expect(out).toMatch(/[▰▱]/); // progress bar present
		expect(out).toContain("codex");
		expect(out).toContain("claude");
	});

	it("narrow pane drops the bar and shows P n/total text only", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 1, max: 3 },
							progress: { current: 2, total: 5 },
						}),
					],
				}),
			],
			selected: 0,
		});
		const { lastFrame } = render(<Wall state={state} cols={45} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("P2/5");
		expect(out).not.toMatch(/[▰▱]/);
	});

	it("renders the degraded per-agent dot as ◐ in THEME.warn (yellow SGR 33)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "healthy" },
								{ agent: "claude", health: "degraded" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("◐");
		// degraded dot uses THEME.warn (yellow). Allow either SGR 33 or the 256/16M variants chalk may emit.
		expect(raw).toMatch(/\x1b\[(33|93|38;5;\d+|38;2;[\d;]+)m[^\x1b]*◐/);
		// claude name uses AGENT_COLOR.claude (#D97757). Allow 256-color or true-color encodings.
		expect(raw).toMatch(/\x1b\[(38;5;\d+|38;2;217;119;87)m[^\x1b]*claude/);
	});

	it("renders the dead per-agent dot as ○ in THEME.err (red SGR 31)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "dead" },
								{ agent: "claude", health: "healthy" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("○");
		// dead dot uses THEME.err (red). Allow SGR 31 or 256/truecolor encodings.
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m[^\x1b]*○/);
		// codex name uses AGENT_COLOR.codex (#5FB3C9).
		expect(raw).toMatch(/\x1b\[(38;5;\d+|38;2;95;179;201)m[^\x1b]*codex/);
	});

	it("renders a healthy per-agent dot as ● in THEME.ok (green SGR 32)", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "running",
							agentHealth: [
								{ agent: "codex", health: "healthy" },
								{ agent: "claude", health: "healthy" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		// healthy dot uses THEME.ok (green).
		expect(raw).toMatch(/\x1b\[(32|92|38;5;\d+|38;2;[\d;]+)m[^\x1b]*●/);
	});
});

describe("Wall — stuck card variant (Task 10)", () => {
	it("stuck card uses ⚠ glyph, red border, and suppresses event rows even when events are present", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "active",
					panes: [
						mkPane({
							collabId: "c1",
							statusKey: "stuck",
							label: "mylabel",
							workflowType: "complex-bug-fixing",
							round: { current: 3, max: 3 },
							stuckWhy: "STUCK 6m12s — round 3/3 max reached → escalated",
							events: [
								{ step: "review", route: "codex→claude", verdict: "pass" },
								{ step: "execute", route: "claude→codex", verdict: "-" },
							],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("⚠");
		expect(out).toContain("STUCK 6m12s");
		expect(out).not.toMatch(/codex→claude/);
		expect(out).not.toMatch(/claude→codex/);
		expect(out).not.toMatch(/\breview\b/);
		expect(out).not.toMatch(/\bexecute\b/);
		expect(out).not.toMatch(/\bpass\b/);
	});
});

describe("Wall — compact card (Task 11)", () => {
	it("compact DONE card uses ✓ glyph, status word, elapsed; no event rows", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "d1",
							statusKey: "done",
							label: "donelabel",
							workflowType: "spec-driven-development",
							round: null,
							progress: { current: 5, total: 5 },
							elapsed: "4m12s",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const out = stripAnsi(lastFrame() ?? "");
		expect(out).toContain("✓ donelabel");
		expect(out).toContain("spec-driven-development");
		expect(out).toContain("P5/5");
		expect(out).toContain("done");
		expect(out).toContain("4m12s");
	});

	it("compact CANCELED card uses ✖ glyph in err color", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "doneCanceled",
					panes: [
						mkPane({
							collabId: "x1",
							statusKey: "canceled",
							label: "cancellabel",
							workflowType: "complex-bug-fixing",
							round: null,
							progress: { current: 3, total: 5 },
							elapsed: "2m08s",
							cardKind: "compact",
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("✖");
		// Err color guard: the raw frame must contain a red SGR (any encoding).
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m/);
	});

	it("compact HALTED card uses ⚠ glyph in err color", () => {
		const state = mkWallState({
			sections: [
				mkSection({
					group: "halted",
					panes: [
						mkPane({
							collabId: "h1",
							statusKey: "stuck",
							label: "haltlabel",
							workflowType: "spec-driven-development",
							round: null,
							progress: { current: 2, total: 4 },
							elapsed: "5m00s",
							cardKind: "compact",
							stuckWhy: null,
							events: [],
						}),
					],
				}),
			],
		});
		const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
		const raw = lastFrame() ?? "";
		const out = stripAnsi(raw);
		expect(out).toContain("⚠");
		expect(raw).toMatch(/\x1b\[(31|91|38;5;\d+|38;2;[\d;]+)m/);
	});
});
