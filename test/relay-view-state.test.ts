import { describe, expect, it } from "vitest";
import { deriveLogLines, buildRelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { RelayHandoffLogRow } from "@ai-whisper/broker";

function row(p: Partial<RelayHandoffLogRow>): RelayHandoffLogRow {
	return {
		handoffId: "h", createdAt: "2026-05-19T08:21:03.000Z", collabId: "c1",
		senderAgent: "codex", targetAgent: "claude", status: "handed_back",
		captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement",
		workflowId: "wf1", phaseRunId: "pr1", handbackText: "wrote spec.plan.md; 5 tasks added",
		evaluatorVerdict: "delivered", evaluatorConfidence: 0.95, evaluatorReason: null,
		...p,
	};
}

const phaseRuns = [
	{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
	  startedAt: "2026-05-19T08:21:00.000Z", endedAt: "2026-05-19T08:24:12.000Z", outcome: "approve" },
	{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
	  startedAt: "2026-05-19T08:25:00.000Z", endedAt: null, outcome: null },
];

describe("deriveLogLines", () => {
	it("workflow handoff → P·R / step / verdict columns + preview", () => {
		const lines = deriveLogLines([row({})], phaseRuns, 4);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("08:21:03");
		expect(ev.text).toContain("P2·R1"); // phaseIndex 1 → "P2" (1-based display)
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).toContain("implement");
		expect(ev.text).toContain("delivered");
		expect(ev.text).toContain("wrote spec.plan.md");
	});

	it("manual relay (null workflow) degrades to time · route · preview", () => {
		const lines = deriveLogLines(
			[row({ workflowId: null, phaseRunId: null, roundNumber: null, handoffStep: null, evaluatorVerdict: null })],
			phaseRuns, 4,
		);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).not.toMatch(/P\d·R\d/);
		expect(ev.text).not.toContain("implement");
	});

	it("emits a phase-start rule when phaseRunId changes", () => {
		const lines = deriveLogLines(
			[row({ handoffId: "h1", phaseRunId: "pr1" }), row({ handoffId: "h2", phaseRunId: "pr2" })],
			phaseRuns, 4,
		);
		expect(lines.filter((l) => l.kind === "phase-rule").map((l) => l.text)).toEqual([
			"── phase 2/4 · plan-writing ──",
			"── phase 3/4 · plan-execution ──",
		]);
	});

	it("emits a phase-complete summary when leaving a closed phase run", () => {
		const lines = deriveLogLines(
			[
				row({ handoffId: "h1", phaseRunId: "pr1", roundNumber: 1, handoffStep: "implement" }),
				row({ handoffId: "h2", phaseRunId: "pr1", roundNumber: 1, handoffStep: "review" }),
				row({ handoffId: "h3", phaseRunId: "pr1", roundNumber: 2, handoffStep: "fix" }),
				row({ handoffId: "h4", phaseRunId: "pr1", roundNumber: 2, handoffStep: "review" }),
				row({ handoffId: "h5", phaseRunId: "pr2", roundNumber: 1, handoffStep: "execute" }),
			],
			phaseRuns, 4,
		);
		const sum = lines.find((l) => l.kind === "phase-summary");
		expect(sum?.text).toBe(
			"✔ plan-writing — 2 rounds (4 handovers) · 3m12s → approve",
		);
		expect(sum && sum.kind === "phase-summary" ? sum.ok : null).toBe(true);
	});

	it("marks an escalated phase summary with ✖ and ok=false", () => {
		const escRuns = [
			{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
			  startedAt: "2026-05-19T08:21:00.000Z", endedAt: "2026-05-19T08:32:40.000Z",
			  outcome: "escalated (max rounds)" },
			{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
			  startedAt: "2026-05-19T08:33:00.000Z", endedAt: null, outcome: null },
		];
		const lines = deriveLogLines(
			[
				row({ handoffId: "a", phaseRunId: "pr1", roundNumber: 5 }),
				row({ handoffId: "b", phaseRunId: "pr2", roundNumber: 1 }),
			],
			escRuns, 4,
		);
		const sum = lines.find((l) => l.kind === "phase-summary");
		expect(sum?.text).toContain("✖ plan-writing — 5 rounds");
		expect(sum?.text).toContain("→ escalated (max rounds)");
		expect(sum && sum.kind === "phase-summary" ? sum.ok : null).toBe(false);
	});

	it("does NOT summarize a phase run that has not ended", () => {
		const lines = deriveLogLines([row({ phaseRunId: "pr2", roundNumber: 1 })], phaseRuns, 4);
		expect(lines.some((l) => l.kind === "phase-summary")).toBe(false);
	});

	it("returns [] for empty handoffs", () => {
		expect(deriveLogLines([], phaseRuns, 4)).toEqual([]);
	});

	it("unknown phaseRunId degrades to route-only line, no rule, no summary", () => {
		const lines = deriveLogLines(
			[row({ phaseRunId: "pr-missing", workflowId: "wf1" })],
			phaseRuns, 4,
		);
		expect(lines.some((l) => l.kind === "phase-rule")).toBe(false);
		expect(lines.some((l) => l.kind === "phase-summary")).toBe(false);
		const ev = lines.find((l) => l.kind === "event")!;
		expect(ev.text).toContain("codex→claude");
		expect(ev.text).not.toMatch(/P\d·R\d/);
	});
});

const baseSnapshot = {
	now: "2026-05-19T08:30:00.000Z",
	idleThresholdMs: 30_000,
	currentStep: "execute" as string | null,
	workflow: {
		workflowId: "wf_048c", workflowType: "spec-driven-development",
		name: "slugify", status: "running" as const,
		createdAt: "2026-05-19T08:22:48.000Z",
		haltReason: null as string | null,
	},
	phaseRuns: [
		{ phaseRunId: "pr1", phaseIndex: 0, phaseName: "spec-refining",
		  startedAt: "2026-05-19T08:22:48.000Z", endedAt: "2026-05-19T08:23:18.000Z", outcome: "approve" },
		{ phaseRunId: "pr2", phaseIndex: 2, phaseName: "plan-execution",
		  startedAt: "2026-05-19T08:27:52.000Z", endedAt: null, outcome: null },
	],
	currentPhaseRunId: "pr2",
	totalPhases: 4,
	chain: { currentRound: 1, maxRounds: 1, status: "active" as const },
	turn: { turnOwner: "codex" as const, waitingAgent: "claude" as const, handoffState: "accepted" as const },
	sessions: [
		{ agentType: "codex", healthState: "healthy" },
		{ agentType: "claude", healthState: "healthy" },
	],
	lastActivityAt: "2026-05-19T08:29:52.000Z",
	handoffs: [],
};

describe("buildRelayViewState — status", () => {
	it("maps progress/turn/health, total+phase elapsed, ALIVE when running & not stuck", () => {
		const s = buildRelayViewState(baseSnapshot);
		expect(s.progress).toBe("Phase 3/4 plan-execution · Round 1/1 · Step execute");
		expect(s.turn).toBe("codex · waiting claude · handoff accepted");
		expect(s.health).toContain("ALIVE");
		expect(s.elapsed).toBe("total 7m12s · phase 2m08s");
		expect(s.stuck).toBe(false);
	});

	it("omits ALIVE and shows terminal state when workflow halted", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow, status: "halted" },
		});
		expect(s.health).not.toContain("ALIVE");
		expect(s.health).toContain("halted");
	});
});
