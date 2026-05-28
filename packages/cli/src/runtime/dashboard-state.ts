import type {
	LogLine,
	PhaseRunRef,
	RelayViewSnapshot,
	RelayViewState,
} from "./relay-view-state.js";
import { buildRelayViewState, deriveLogLines, fmtDur } from "./relay-view-state.js";
import { statusGlyph } from "./dashboard-glyph.js";
import type {
	CollabSummary,
	RelayHandoffLogRow,
	RunCostRow,
	WorkflowSummaryRow,
} from "@ai-whisper/broker";

export type WallEvent = { step: string; route: string; verdict: string };

export type WallPaneState = {
	collabId: string;
	workflowId: string | null;
	statusKey: "running" | "stuck" | "done" | "canceled" | "idle";
	label: string;
	workflowType: string | null;
	round: { current: number; max: number } | null;
	progress: { current: number; total: number } | null;
	agentHealth: Array<{
		agent: "codex" | "claude";
		health: "healthy" | "degraded" | "dead";
	}>;
	stuckWhy: string | null;
	events: WallEvent[]; // newest first, length ≤ 2
	elapsed: string; // for compact card line 2
	cardKind: "full" | "compact";
};
export type WallState = {
	panes: WallPaneState[];
	page: number;
	pageCount: number;
	totalRuns: number;
	selected: number;
};
export type PhaseStat = {
	phaseIndex: number;
	phaseName: string;
	roundsUsed: number;
	maxRounds: number;
	durationMs: number | null;
	outcome: string | null;
	estInTokens: number;
	estOutTokens: number;
};
export type EvidenceItem = {
	round: number | null;
	step: string | null;
	sender: string;
	target: string;
	verdict: string | null;
	confidence: number | null;
	reasonExcerpt: string;
	captureStatus: string | null;
};
export type DiagItem = { kind: "evaluator" | "capture"; text: string };
export type CostSummary = {
	totalMs: number;
	estInputTokens: number;
	estOutputTokens: number;
	perPhase: Array<{
		phaseRunId: string | null;
		phaseName: string;
		estInTokens: number;
		estOutTokens: number;
		durationMs: number | null;
	}>;
};
export type WorkflowHistoryItem = {
	workflowId: string;
	workflowType: string;
	name: string | null;
	status: "running" | "paused" | "done" | "halted" | "canceled";
	currentPhaseIndex: number;
	createdAt: string;
	selected: boolean;
};
export type InspectorState = {
	live: RelayViewState;
	timeline: PhaseStat[];
	// Bug B: full workflow run history for the inspected collab (newest-first).
	// The `selected` flag marks which workflow the timeline/evidence currently
	// reflect. Empty when no workflows were passed.
	workflowHistory: WorkflowHistoryItem[];
	evidence: {
		phase: string | null;
		chainId: string | null;
		items: EvidenceItem[];
		diagnostics: DiagItem[];
		likelyCause: string;
	};
	cost: CostSummary;
};

// v1 token estimate — labeled "≈ est, not metered" at the UI layer.
export function estimateTokens(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.ceil(chars / 4);
}

// Re-export the reused pure helpers so later tasks/tests import from one place.
export { buildRelayViewState, deriveLogLines, fmtDur };
export type { LogLine, PhaseRunRef, RelayViewSnapshot, RelayViewState, RelayHandoffLogRow, CollabSummary, RunCostRow };

function attentionRank(s: CollabSummary): number {
	if (
		s.chainStatus === "escalated" ||
		s.chainStatus === "abandoned" ||
		s.workflowStatus === "halted" ||
		s.workflowStatus === "canceled"
	)
		return 0; // stuck
	if (s.workflowStatus === "running") return 1; // active
	if (s.workflowStatus === "done") return 3; // done
	return 2; // idle (incl. manual relay)
}

// `CollabSummary.lastActivityAt` is "" for a running workflow with no
// handoffs yet (Task-1 contract: that's the MOST recent activity). Map ""
// to a max sentinel so the desc tiebreak sorts it FIRST within its rank,
// not lexicographic-last.
function actKey(s: CollabSummary): string {
	return s.lastActivityAt === "" ? "￿" : s.lastActivityAt;
}

// Pure sort + paginate, NO projection (no snapshots needed). The host calls
// this FIRST so it fetches per-collab snapshots ONLY for the visible page —
// spec §4 bounded cost: an off-screen collab costs just its summary row.
// buildWallState reuses it so the ordering is single-sourced.
export function selectWallPage(input: {
	summaries: CollabSummary[];
	capacity: number;
	page: number;
	selected: number;
}): {
	pageSummaries: CollabSummary[];
	page: number;
	pageCount: number;
	totalRuns: number;
	selected: number;
} {
	const cap = Math.max(1, Math.floor(input.capacity));
	const sorted = [...input.summaries].sort((a, b) => {
		const r = attentionRank(a) - attentionRank(b);
		if (r !== 0) return r;
		const ka = actKey(a);
		const kb = actKey(b);
		return ka < kb ? 1 : ka > kb ? -1 : 0;
	});
	const totalRuns = sorted.length;
	const pageCount = Math.ceil(totalRuns / cap);
	const page =
		totalRuns === 0 ? 0 : Math.min(Math.max(0, input.page), pageCount - 1);
	const pageSummaries = sorted.slice(page * cap, page * cap + cap);
	const selected =
		pageSummaries.length === 0
			? 0
			: Math.min(Math.max(0, input.selected), pageSummaries.length - 1);
	return { pageSummaries, page, pageCount, totalRuns, selected };
}

function maxIso(rows: RunCostRow[]): string | null {
	let m: string | null = null;
	for (const r of rows) {
		const t = r.resolvedAt ?? r.lastActivityAt;
		if (m === null || t > m) m = t;
	}
	return m;
}
function minIso(rows: RunCostRow[]): string | null {
	let m: string | null = null;
	for (const r of rows) if (m === null || r.createdAt < m) m = r.createdAt;
	return m;
}

export function buildInspectorState(input: {
	snapshot: RelayViewSnapshot;
	phaseRuns: PhaseRunRef[];
	phaseMaxRounds: Record<number, number>;
	costRows: RunCostRow[];
	workflowCreatedAt: string | null;
	chainId: string | null;
	evidenceHandoffs: RelayHandoffLogRow[];
	evaluatorDiags: Array<{ verdict: string | null; confidence: number | null; reason: string | null; outcome: string }>;
	captureDiags: Array<{ captureStatus: string; turnConfidence: string }>;
	focusedPhaseRunId: string | null;
	// Bug B (optional, additive): the collab's full workflow run history and
	// which workflow is currently selected/inspected. Absent → empty history.
	workflows?: WorkflowSummaryRow[];
	selectedWorkflowId?: string | null;
}): InspectorState {
	const live = buildRelayViewState(input.snapshot);

	const inByPhase = new Map<string | null, number>();
	const outByPhase = new Map<string | null, number>();
	let totalIn = 0;
	let totalOut = 0;
	for (const r of input.costRows) {
		inByPhase.set(r.phaseRunId, (inByPhase.get(r.phaseRunId) ?? 0) + r.inChars);
		outByPhase.set(r.phaseRunId, (outByPhase.get(r.phaseRunId) ?? 0) + r.outChars);
		totalIn += r.inChars;
		totalOut += r.outChars;
	}

	const roundsByPhase = new Map<string, number>();
	for (const h of input.snapshot.handoffs) {
		if (h.phaseRunId && h.roundNumber != null) {
			roundsByPhase.set(
				h.phaseRunId,
				Math.max(roundsByPhase.get(h.phaseRunId) ?? 0, h.roundNumber),
			);
		}
	}

	const timeline: PhaseStat[] = input.phaseRuns
		.slice()
		.sort((a, b) => a.phaseIndex - b.phaseIndex)
		.map((p) => ({
			phaseIndex: p.phaseIndex,
			phaseName: p.phaseName,
			roundsUsed: roundsByPhase.get(p.phaseRunId) ?? 0,
			maxRounds: input.phaseMaxRounds[p.phaseIndex] ?? 0,
			durationMs:
				p.endedAt != null ? Date.parse(p.endedAt) - Date.parse(p.startedAt) : null,
			outcome: p.outcome,
			estInTokens: estimateTokens(inByPhase.get(p.phaseRunId) ?? 0),
			estOutTokens: estimateTokens(outByPhase.get(p.phaseRunId) ?? 0),
		}));

	const phaseName = new Map(input.phaseRuns.map((p) => [p.phaseRunId, p.phaseName]));
	const perPhaseKeys: Array<string | null> = [];
	for (const r of input.costRows) if (!perPhaseKeys.includes(r.phaseRunId)) perPhaseKeys.push(r.phaseRunId);
	const durByPhase = new Map(
		input.phaseRuns.map((p) => [
			p.phaseRunId,
			p.endedAt != null ? Date.parse(p.endedAt) - Date.parse(p.startedAt) : null,
		]),
	);
	const cost: CostSummary = {
		totalMs: (() => {
			if (input.costRows.length === 0) return 0;
			const end = maxIso(input.costRows);
			const base = input.workflowCreatedAt ?? minIso(input.costRows);
			if (!end || !base) return 0;
			return Math.max(0, Date.parse(end) - Date.parse(base));
		})(),
		estInputTokens: estimateTokens(totalIn),
		estOutputTokens: estimateTokens(totalOut),
		perPhase: perPhaseKeys.map((k) => ({
			phaseRunId: k,
			phaseName: k ? (phaseName.get(k) ?? k) : "manual relay",
			estInTokens: estimateTokens(inByPhase.get(k) ?? 0),
			estOutTokens: estimateTokens(outByPhase.get(k) ?? 0),
			durationMs: k ? (durByPhase.get(k) ?? null) : null,
		})),
	};

	const excerpt = (s: string | null): string => {
		const t = (s ?? "").replace(/\s+/g, " ").trim();
		return t.length > 80 ? `${t.slice(0, 80)}…` : t;
	};
	const items: EvidenceItem[] = input.evidenceHandoffs.map((h) => ({
		round: h.roundNumber,
		step: h.handoffStep,
		sender: h.senderAgent,
		target: h.targetAgent,
		verdict: h.evaluatorVerdict,
		confidence: h.evaluatorConfidence,
		reasonExcerpt: excerpt(h.evaluatorReason),
		captureStatus: h.captureStatus,
	}));
	const diagnostics: DiagItem[] = [
		...input.evaluatorDiags.map((d) => ({
			kind: "evaluator" as const,
			text: `verdict ${d.verdict ?? "-"} conf ${d.confidence ?? "-"} · ${d.outcome} · ${excerpt(d.reason).slice(0, 60)}`,
		})),
		...input.captureDiags.map((d) => ({
			kind: "capture" as const,
			text: `capture ${d.captureStatus} · turn ${d.turnConfidence}`,
		})),
	];
	const confs = input.evaluatorDiags
		.map((d) => d.confidence)
		.filter((c): c is number => typeof c === "number");
	const declining = confs.length >= 2 && confs[confs.length - 1]! < confs[0]!;
	const captureBad = input.captureDiags.some((d) => d.captureStatus !== "ok");
	const rounds = input.snapshot.chain?.currentRound ?? 0;
	const maxR = input.snapshot.chain?.maxRounds ?? 0;
	let likelyCause: string;
	if (
		live.stuck &&
		(input.snapshot.chain?.status === "escalated" ||
			(maxR > 1 && rounds >= maxR)) &&
		declining
	) {
		likelyCause = `${rounds}/${maxR} rounds, verdict never reached approve, confidence declining → likely under-specified input or maxRounds too low`;
	} else if (captureBad) {
		likelyCause = `capture issues (${input.captureDiags.filter((d) => d.captureStatus !== "ok").length}) — provider output may be truncated/low-confidence`;
	} else if (live.stuck) {
		likelyCause = `stuck: ${live.why ?? "see status"}`;
	} else {
		likelyCause = "no blocking signal — run progressing";
	}
	const evidence = {
		phase:
			input.phaseRuns.find((p) => p.phaseRunId === input.focusedPhaseRunId)
				?.phaseName ?? null,
		chainId: input.chainId,
		items,
		diagnostics,
		likelyCause,
	};

	const workflowHistory: WorkflowHistoryItem[] = (input.workflows ?? []).map((w) => ({
		workflowId: w.workflowId,
		workflowType: w.workflowType,
		name: w.name,
		status: w.status,
		currentPhaseIndex: w.currentPhaseIndex,
		createdAt: w.createdAt,
		selected: input.selectedWorkflowId != null && w.workflowId === input.selectedWorkflowId,
	}));

	return { live, timeline, evidence, cost, workflowHistory };
}

// deriveLogLines emits: "HH:MM:SS  P·R   sender→target  step   verdict   preview"
// We want step / route / verdict only.
function parseEventText(text: string): WallEvent {
	const cols = text.split(/\s{2,}/);
	const route = cols.find((c) => /[a-z]+→[a-z]+/i.test(c)) ?? "";
	const tokens = cols.filter((c) => c !== route);
	// tokens[0] = time, tokens[1] = P·R (when workflow), tokens[2] = step, tokens[3] = verdict
	const step = tokens[2] ?? "";
	const verdict = tokens[3] ?? "-";
	return { step, route, verdict };
}

function projectPane(
	s: CollabSummary,
	now: string,
	idleThresholdMs: number,
	snap: { handoffs: RelayHandoffLogRow[]; phaseRuns: PhaseRunRef[]; totalPhases: number },
): WallPaneState {
	// Bug C / Task 8b: feed the active step into the liveness snapshot so the
	// phase-aware budget (execute/review → larger) applies on the Wall too.
	let wallStep: string | null = null;
	if (s.currentPhaseRunId) {
		for (let i = snap.handoffs.length - 1; i >= 0; i--) {
			if (snap.handoffs[i]!.phaseRunId === s.currentPhaseRunId) {
				wallStep = snap.handoffs[i]!.handoffStep;
				break;
			}
		}
	}
	const rv = buildRelayViewState({
		now,
		idleThresholdMs,
		workflow:
			s.workflowId && s.workflowType
				? {
						workflowId: s.workflowId,
						workflowType: s.workflowType,
						name: s.label,
						status: s.workflowStatus ?? "running",
						createdAt: s.workflowCreatedAt ?? now,
						haltReason: null,
					}
				: null,
		phaseRuns: snap.phaseRuns,
		currentPhaseRunId: s.currentPhaseRunId,
		currentStep: wallStep, // budget input only; the pane still renders P/R
		totalPhases: snap.totalPhases,
		chain:
			s.currentRound != null && s.maxRounds != null && s.chainStatus
				? { currentRound: s.currentRound, maxRounds: s.maxRounds, status: s.chainStatus }
				: null,
		turn: {
			turnOwner: s.turn.owner,
			waitingAgent: s.turn.waiting,
			handoffState: s.turn.handoffState,
		},
		sessions: s.sessions,
		lastActivityAt: s.lastActivityAt,
		handoffs: snap.handoffs,
	});
	const glyph = statusGlyph({
		workflowStatus: s.workflowStatus,
		stuck: rv.stuck,
	});
	const round =
		s.currentRound != null && s.maxRounds != null
			? { current: s.currentRound, max: s.maxRounds }
			: null;
	const progress =
		s.phaseIndex != null && snap.totalPhases > 0
			? { current: s.phaseIndex + 1, total: snap.totalPhases }
			: null;
	const events = rv.logLines
		.filter((l) => l.kind === "event")
		.slice(-2)
		.reverse() // newest first
		.map((l) => parseEventText(l.text));
	const cardKind: "full" | "compact" = glyph.key === "running" ? "full" : "compact";
	const nowMs = Date.parse(now);
	const baseMs = s.workflowCreatedAt != null ? Date.parse(s.workflowCreatedAt) : NaN;
	const elapsed =
		Number.isFinite(nowMs) && Number.isFinite(baseMs)
			? fmtDur(nowMs - baseMs)
			: "—";

	return {
		collabId: s.collabId,
		workflowId: s.workflowId,
		statusKey: glyph.key,
		label: s.label,
		workflowType: s.workflowType,
		round,
		progress,
		agentHealth: rv.agentHealth,
		stuckWhy: rv.stuck ? rv.why : null,
		events,
		elapsed,
		cardKind,
	};
}

export function buildWallState(input: {
	summaries: CollabSummary[];
	now: string;
	idleThresholdMs: number;
	capacity: number;
	page: number;
	selected: number;
	snapshots: Record<
		string,
		{ handoffs: RelayHandoffLogRow[]; phaseRuns: PhaseRunRef[]; totalPhases: number }
	>;
}): WallState {
	const sel = selectWallPage({
		summaries: input.summaries,
		capacity: input.capacity,
		page: input.page,
		selected: input.selected,
	});
	const panes: WallPaneState[] = sel.pageSummaries.map((s) => {
		const snap = input.snapshots[s.collabId] ?? {
			handoffs: [],
			phaseRuns: [],
			totalPhases: 0,
		};
		return projectPane(s, input.now, input.idleThresholdMs, snap);
	});
	return {
		panes,
		page: sel.page,
		pageCount: sel.pageCount,
		totalRuns: sel.totalRuns,
		selected: sel.selected,
	};
}
