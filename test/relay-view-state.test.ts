import { describe, expect, it } from "vitest";
import { deriveLogLines, buildRelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { RelayViewSnapshot } from "../packages/cli/src/runtime/relay-view-state.ts";
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

const baseSnapshot: RelayViewSnapshot = {
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
			workflow: { ...baseSnapshot.workflow!, status: "halted" },
		});
		expect(s.health).not.toContain("ALIVE");
		expect(s.health).toContain("halted");
	});

	it("manual relay (workflow null) → wf label, progress —, elapsed —, last —", () => {
		const s = buildRelayViewState({
			...baseSnapshot, workflow: null, chain: null,
			currentPhaseRunId: null, currentStep: null, handoffs: [],
		});
		expect(s.wf).toBe("(no workflow — manual relay)");
		expect(s.progress).toBe("—");
		expect(s.elapsed).toBe("total — · phase —");
		expect(s.last).toBe("—");
	});

	it("chain null → Round 1/1 fallback in progress", () => {
		const s = buildRelayViewState({ ...baseSnapshot, chain: null });
		expect(s.progress).toBe("Phase 3/4 plan-execution · Round 1/1 · Step execute");
	});

	it("currentPhaseRunId not in phaseRuns → progress — and phase elapsed —", () => {
		const s = buildRelayViewState({ ...baseSnapshot, currentPhaseRunId: "nope" });
		expect(s.progress).toBe("—");
		expect(s.elapsed).toBe("total 7m12s · phase —");
	});

	it("terminal done appends ✔ workflow-done tail line after deriveLogLines", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "done" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail).toEqual({ kind: "phase-summary", ok: true, text: "✔ workflow-done: wf_048c" });
		expect(s.health).not.toContain("ALIVE");
	});

	it("terminal canceled with haltReason appends ✖ tail with reason", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "canceled", haltReason: "user aborted" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail).toEqual({
			kind: "phase-summary", ok: false,
			text: "✖ workflow-canceled: wf_048c — user aborted",
		});
	});

	it("terminal canceled with empty-string haltReason omits the — suffix", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "canceled", haltReason: "" },
		});
		const tail = s.logLines[s.logLines.length - 1];
		expect(tail && tail.kind === "phase-summary" ? tail.text : "").toBe(
			"✖ workflow-canceled: wf_048c",
		);
	});

	it("empty sessions → both health dots render dead", () => {
		const s = buildRelayViewState({ ...baseSnapshot, sessions: [] });
		expect(s.health).toContain("●(dead) codex");
		expect(s.health).toContain("●(dead) claude");
	});

	it("populated last handoff renders verdict/confidence/capture/reason", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			handoffs: [{
				handoffId: "h", createdAt: "2026-05-19T08:29:00.000Z", collabId: "c1",
				senderAgent: "codex", targetAgent: "claude", status: "handed_back",
				captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "review",
				workflowId: "wf_048c", phaseRunId: "pr2",
				handbackText: "done", evaluatorVerdict: "delivered",
				evaluatorConfidence: 0.95, evaluatorReason: "looks good",
			}],
		});
		expect(s.last).toBe('delivered 0.95 · capture ok · "looks good"');
	});
});

describe("computeLiveness via buildRelayViewState", () => {
	it("idle countdown to auto-handback when accepted and within threshold", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:29:52.000Z", // idle 8s
			idleThresholdMs: 30_000,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 8s · auto-handback in 22s");
		expect(s.why).toBeNull();
	});

	it("stuck: round at maxRounds → why states round-max → escalate", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 5, maxRounds: 5, status: "active" as const },
			lastActivityAt: "2026-05-19T08:26:58.000Z", // idle 182s
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("round 5/5 max reached");
	});

	it("stuck: chain.status escalated/abandoned → why + health shows it", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 2, maxRounds: 5, status: "escalated" as const },
			lastActivityAt: "2026-05-19T08:29:55.000Z", // only idle 5s — not idle-stuck
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("chain escalated");
		expect(s.health).toContain("Chain escalated");
		expect(s.health).not.toContain("ALIVE");
	});

	it("stuck: idle beyond 2× threshold (≥60s) with no progress", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			idleThresholdMs: 30_000,
			lastActivityAt: "2026-05-19T08:27:00.000Z", // idle 180s ≥ max(60, 60s)
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "pending" },
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toMatch(/STUCK \d+s/);
	});

	it("halt_reason wins as the why when workflow halted", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "halted", haltReason: "max-rounds-reached (phase plan-writing)" },
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("max-rounds-reached");
	});

	it("stuck: provider unhealthy when a session is not healthy", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s — not idle-stuck
			sessions: [
				{ agentType: "codex", healthState: "degraded" },
				{ agentType: "claude", healthState: "healthy" },
			],
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("provider unhealthy");
	});

	it("empty sessions is NOT provider-stuck", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s
			sessions: [],
		});
		expect(s.stuck).toBe(false);
		expect(s.why).toBeNull();
	});

	it("pending handoff within threshold → auto-accept countdown", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "2026-05-19T08:30:00.000Z",
			lastActivityAt: "2026-05-19T08:29:52.000Z", // idle 8s
			idleThresholdMs: 30_000,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "pending" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 8s · auto-accept in 22s");
	});

	it("chain abandoned → stuck with why", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			chain: { currentRound: 2, maxRounds: 5, status: "abandoned" as const },
			lastActivityAt: "2026-05-19T08:29:55.000Z", // idle 5s
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toContain("chain abandoned");
	});

	it("null lastActivityAt → idle 0s, not idle-stuck", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			lastActivityAt: null,
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.stuck).toBe(false);
		expect(s.live).toBe("idle 0s · auto-handback in 30s");
	});

	it("halted with no haltReason → why is 'workflow halted'", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			workflow: { ...baseSnapshot.workflow!, status: "halted", haltReason: null },
		});
		expect(s.stuck).toBe(true);
		expect(s.why).toBe("workflow halted");
	});

	it("unparseable timestamps degrade to idle 0s, never 'NaN'", () => {
		const s = buildRelayViewState({
			...baseSnapshot,
			now: "not-a-date",
			lastActivityAt: "also-not-a-date",
			turn: { turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted" },
		});
		expect(s.live).not.toContain("NaN");
		expect(s.why ?? "").not.toContain("NaN");
		expect(s.live).toBe("idle 0s · auto-handback in 30s");
	});
});
