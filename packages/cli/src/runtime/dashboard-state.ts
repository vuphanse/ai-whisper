import type {
	LogLine,
	PhaseRunRef,
	RelayViewSnapshot,
	RelayViewState,
} from "./relay-view-state.js";
import { buildRelayViewState, deriveLogLines, fmtDur } from "./relay-view-state.js";
import type { RelayHandoffLogRow } from "@ai-whisper/broker";

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
export type { LogLine, PhaseRunRef, RelayViewSnapshot, RelayViewState, RelayHandoffLogRow };
