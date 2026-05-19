import type {
	LogLine,
	PhaseRunRef,
	RelayViewSnapshot,
	RelayViewState,
} from "./relay-view-state.js";
import { buildRelayViewState, deriveLogLines, fmtDur } from "./relay-view-state.js";
import type { CollabSummary, RelayHandoffLogRow, RunCostRow } from "@ai-whisper/broker";

export type WallPaneState = {
	collabId: string;
	workflowId: string | null;
	header: string;
	healthLine: string;
	stuck: boolean;
	logTail: LogLine[];
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
export type InspectorState = {
	live: RelayViewState;
	timeline: PhaseStat[];
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
		const rv = buildRelayViewState({
			now: input.now,
			idleThresholdMs: input.idleThresholdMs,
			workflow:
				s.workflowId && s.workflowType
					? {
							workflowId: s.workflowId,
							workflowType: s.workflowType,
							name: s.label,
							status: s.workflowStatus ?? "running",
							createdAt: input.now,
							haltReason: null,
						}
					: null,
			phaseRuns: snap.phaseRuns,
			currentPhaseRunId: s.currentPhaseRunId,
			currentStep: null, // wall pane (density B) renders P/R only, not Step
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
		const header =
			!s.workflowId || !s.workflowType
				? `${s.label}  manual relay`
				: `${s.label}  ${s.workflowType}  P${(s.phaseIndex ?? 0) + 1}/${
						snap.totalPhases || "?"
					}${
						s.currentRound != null && s.maxRounds != null
							? ` R${s.currentRound}/${s.maxRounds}`
							: ""
					}`;
		const events = rv.logLines.filter((l) => l.kind === "event");
		return {
			collabId: s.collabId,
			workflowId: s.workflowId,
			header,
			healthLine: rv.stuck && rv.why ? `⚠ ${rv.why}` : rv.health,
			stuck: rv.stuck,
			logTail: events.slice(-2),
		};
	});
	return {
		panes,
		page: sel.page,
		pageCount: sel.pageCount,
		totalRuns: sel.totalRuns,
		selected: sel.selected,
	};
}
