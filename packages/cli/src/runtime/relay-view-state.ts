import type { RelayHandoffLogRow } from "@ai-whisper/broker";

// Fixed column widths for the workflow event line (kept here so Task 5/6
// renderers stay aligned with this producer).
const COL = { pr: 6, route: 13, step: 9, verdict: 9 } as const;

export type PhaseRunRef = {
	phaseRunId: string;
	phaseIndex: number;
	phaseName: string;
	startedAt: string;
	endedAt: string | null;
	outcome: string | null;
};

export type LogLine =
	| { kind: "event"; text: string; isLatest: boolean }
	| { kind: "phase-rule"; text: string }
	| { kind: "phase-summary"; text: string; ok: boolean };

// Formats timestamp in UTC intentionally (relay logs recorded in UTC).
function hhmmss(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// Shared duration formatter. Defined here (this file is created in Task 4);
// Task 5 reuses it and MUST NOT redefine it.
export function fmtDur(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function isOkOutcome(outcome: string | null): boolean {
	if (!outcome) return false;
	return !/escalat|halt|fail|cancel/i.test(outcome);
}

function summaryLine(
	phase: PhaseRunRef,
	rounds: number,
	handovers: number,
): LogLine {
	const ok = isOkOutcome(phase.outcome);
	const dur =
		phase.endedAt != null
			? fmtDur(Date.parse(phase.endedAt) - Date.parse(phase.startedAt))
			: "?";
	return {
		kind: "phase-summary",
		ok,
		text: `${ok ? "✔" : "✖"} ${phase.phaseName} — ${rounds} rounds (${handovers} handovers) · ${dur} → ${phase.outcome ?? "?"}`,
	};
}

export function deriveLogLines(
	handoffs: RelayHandoffLogRow[],
	phaseRuns: PhaseRunRef[],
	totalPhases: number,
): LogLine[] {
	const byPhaseRun = new Map(phaseRuns.map((p) => [p.phaseRunId, p]));
	const out: LogLine[] = [];
	let lastPhaseRunId: string | null = null;
	// stats for the currently-open phase run (for its summary on close)
	let curRunId: string | null = null;
	let curRounds = 0;
	let curHandovers = 0;

	function flushSummary() {
		if (curRunId === null) return;
		const run = byPhaseRun.get(curRunId);
		// only summarize a phase run that has actually ended
		if (run && run.endedAt != null) {
			out.push(summaryLine(run, Math.max(1, curRounds), curHandovers));
		}
	}

	handoffs.forEach((h, i) => {
		const isLatest = i === handoffs.length - 1;
		// If a handoff carries a phaseRunId not present in phaseRuns, phase is
		// undefined and the event intentionally degrades to the route-only line;
		// it is also excluded from phase stats. Defensive against upstream data gaps.
		const phase = h.phaseRunId ? byPhaseRun.get(h.phaseRunId) : undefined;

		if (h.phaseRunId && h.phaseRunId !== lastPhaseRunId && phase) {
			// closing the previous phase run → emit its summary first
			flushSummary();
			out.push({
				kind: "phase-rule",
				text: `── phase ${phase.phaseIndex + 1}/${totalPhases} · ${phase.phaseName} ──`,
			});
			lastPhaseRunId = h.phaseRunId;
			curRunId = h.phaseRunId;
			curRounds = 0;
			curHandovers = 0;
		}

		if (h.phaseRunId && h.phaseRunId === curRunId) {
			curHandovers += 1;
			if (h.roundNumber != null) curRounds = Math.max(curRounds, h.roundNumber);
		}

		const time = hhmmss(h.createdAt);
		const route = `${h.senderAgent}→${h.targetAgent}`;
		const preview = (h.handbackText ?? "").replace(/\s+/g, " ").trim();

		if (h.workflowId && phase && h.roundNumber != null) {
			const pr = `P${phase.phaseIndex + 1}·R${h.roundNumber}`;
			const step = pad(h.handoffStep ?? "-", COL.step);
			const verdict = pad(h.evaluatorVerdict ?? "-", COL.verdict);
			out.push({
				kind: "event",
				isLatest,
				text: `${time}  ${pad(pr, COL.pr)}  ${pad(route, COL.route)}  ${step}  ${verdict}  ${preview}`,
			});
		} else {
			out.push({
				kind: "event",
				isLatest,
				text: `${time}  ${pad(route, COL.route)}  ${preview}`,
			});
		}
	});

	// summarize the final phase run if it has ended
	flushSummary();

	return out;
}
