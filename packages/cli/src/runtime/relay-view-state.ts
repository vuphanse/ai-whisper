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

export type RelayViewSnapshot = {
	now: string;
	idleThresholdMs: number;
	workflow: {
		workflowId: string;
		workflowType: string;
		name: string | null;
		status: "running" | "done" | "halted" | "canceled";
		createdAt: string;
		haltReason?: string | null;
	} | null;
	phaseRuns: Array<{
		phaseRunId: string;
		phaseIndex: number;
		phaseName: string;
		startedAt: string;
		endedAt: string | null;
		outcome: string | null;
	}>;
	currentPhaseRunId: string | null;
	currentStep: string | null;
	totalPhases: number;
	chain: {
		currentRound: number;
		maxRounds: number;
		status: "active" | "done" | "escalated" | "abandoned";
	} | null;
	turn: {
		turnOwner: "codex" | "claude" | "none";
		waitingAgent: "codex" | "claude" | null;
		handoffState: string;
	};
	sessions: Array<{ agentType: string; healthState: string }>;
	lastActivityAt: string | null;
	handoffs: RelayHandoffLogRow[];
};

export type RelayViewState = {
	wf: string;
	progress: string;
	elapsed: string;
	turn: string;
	health: string;
	live: string;
	why: string | null; // when set, render the red ⚠ why row instead of live
	last: string;
	stuck: boolean;
	logLines: LogLine[];
};

// `fmtDur` is already defined in this file (Task 4) — do NOT redefine it here.

// Canonical relay agent pair (order = display order). Task 6 liveness reuses this.
const RELAY_AGENTS = ["codex", "claude"] as const;

const WF_ID_DISPLAY_LEN = 12;

// Returns a formatted elapsed string, or "—" if either timestamp is unparseable
// (broker/DB timestamps are trusted, but a malformed one must not render "NaNs"
// in a liveness monitor).
function elapsedSince(fromIso: string | null | undefined, toIso: string): string {
	if (fromIso == null) return "—";
	const a = Date.parse(fromIso);
	const b = Date.parse(toIso);
	if (Number.isNaN(a) || Number.isNaN(b)) return "—";
	return fmtDur(b - a);
}

function computeLiveness(snap: RelayViewSnapshot): {
	stuck: boolean;
	why: string | null;
	liveText: string;
} {
	// Trusted broker timestamps, but a malformed one must not render "NaNs"
	// (mirrors the elapsedSince guard above); clock skew must not show "-3s".
	const nowMs = Date.parse(snap.now);
	const lastMs = snap.lastActivityAt ? Date.parse(snap.lastActivityAt) : null;
	const idleMs =
		lastMs !== null && !Number.isNaN(nowMs) && !Number.isNaN(lastMs)
			? Math.max(0, nowMs - lastMs)
			: 0;
	const idleS = Math.floor(idleMs / 1000);
	const thresholdMs = snap.idleThresholdMs;
	// stuck = 2× the idle threshold, floored at 60s.
	const stuckThresholdMs = Math.max(60_000, thresholdMs * 2);

	const round = snap.chain?.currentRound ?? 1;
	const maxRounds = snap.chain?.maxRounds ?? 1;
	const chainStatus = snap.chain?.status;
	const terminal =
		snap.workflow && snap.workflow.status !== "running" ? snap.workflow.status : null;

	// why precedence: halt_reason > chain escalated/abandoned > round-max
	//                  > idle/provider-silent
	let why: string | null = null;
	let stuck = false;

	if (terminal === "halted" || terminal === "canceled") {
		stuck = true;
		why = snap.workflow?.haltReason
			? `${terminal}: ${snap.workflow.haltReason}`
			: `workflow ${terminal}`;
	} else if (chainStatus === "escalated" || chainStatus === "abandoned") {
		stuck = true;
		why = `STUCK — chain ${chainStatus}`;
	// maxRounds>1: a single-round workflow never round-max-stucks (escalation comes via chain.status).
	} else if (snap.chain && round >= maxRounds && maxRounds > 1) {
		stuck = true;
		why = `STUCK ${fmtDur(idleMs)} — round ${round}/${maxRounds} max reached → escalated`;
	} else if (idleMs >= stuckThresholdMs) {
		stuck = true;
		why = `STUCK ${idleS}s — no progress (idle > ${Math.floor(stuckThresholdMs / 1000)}s)`;
	} else if (snap.sessions.some((s) => s.healthState !== "healthy")) {
		stuck = true;
		why = "STUCK — provider unhealthy";
	}

	// live countdown (only when not stuck)
	let liveText = `idle ${idleS}s`;
	if (!stuck) {
		const remainMs = Math.max(0, thresholdMs - idleMs);
		if (snap.turn.handoffState === "accepted") {
			liveText = `idle ${idleS}s · auto-handback in ${Math.ceil(remainMs / 1000)}s`;
		} else if (snap.turn.handoffState === "pending") {
			liveText = `idle ${idleS}s · auto-accept in ${Math.ceil(remainMs / 1000)}s`;
		}
	}

	return { stuck, why, liveText };
}

export function buildRelayViewState(snap: RelayViewSnapshot): RelayViewState {
	const wf = snap.workflow
		? `${snap.workflow.workflowType}  ${snap.workflow.workflowId.slice(0, WF_ID_DISPLAY_LEN)}…  "${snap.workflow.name ?? snap.workflow.workflowType}"`
		: "(no workflow — manual relay)";

	const cur = snap.phaseRuns.find((p) => p.phaseRunId === snap.currentPhaseRunId) ?? null;
	const round = snap.chain?.currentRound ?? 1;
	const maxRounds = snap.chain?.maxRounds ?? 1;
	const progress = cur
		? `Phase ${cur.phaseIndex + 1}/${snap.totalPhases} ${cur.phaseName} · Round ${round}/${maxRounds} · Step ${snap.currentStep ?? "-"}`
		: "—";

	const totalEl = elapsedSince(snap.workflow?.createdAt, snap.now);
	const phaseEl = elapsedSince(cur?.startedAt, snap.now);
	const elapsed = `total ${totalEl} · phase ${phaseEl}`;

	const turn = `${snap.turn.turnOwner} · waiting ${snap.turn.waitingAgent ?? "none"} · handoff ${snap.turn.handoffState}`;

	const dots = RELAY_AGENTS
		.map((a) => {
			const sess = snap.sessions.find((x) => x.agentType === a);
			const ok = sess?.healthState === "healthy";
			return `${ok ? "●" : "●(dead)"} ${a}`;
		})
		.join("  ");

	// stuck + why computed in Task 6; placeholder defaults overwritten there.
	const { stuck, why, liveText } = computeLiveness(snap);

	const terminal =
		snap.workflow && snap.workflow.status !== "running" ? snap.workflow.status : null;
	// chain.status (active/done/escalated/abandoned) is shown when not terminal
	// and not the soft "stuck" state.
	const chainStatus = snap.chain?.status;
	const chainState =
		terminal ??
		(chainStatus && chainStatus !== "active"
			? chainStatus
			: stuck
				? "stuck"
				: "active");
	const alive = !terminal && !stuck && (chainStatus ?? "active") === "active";
	const health = `${dots}  Chain ${chainState}${alive ? " · ALIVE" : ""}`;

	const lastHandoff = snap.handoffs[snap.handoffs.length - 1] ?? null;
	const last = lastHandoff
		? `${lastHandoff.evaluatorVerdict ?? "-"} ${
				lastHandoff.evaluatorConfidence ?? "-"
			} · capture ${lastHandoff.captureStatus ?? "-"}${
				lastHandoff.evaluatorReason ? ` · "${lastHandoff.evaluatorReason}"` : ""
			}`
		: "—";

	const logLines = deriveLogLines(snap.handoffs, snap.phaseRuns, snap.totalPhases);

	// Spec §6: when the workflow is terminal, the log ends with an explicit
	// terminal line.
	if (terminal) {
		const id = snap.workflow!.workflowId;
		logLines.push(
			terminal === "done"
				? { kind: "phase-summary", ok: true, text: `✔ workflow-done: ${id}` }
				: {
						kind: "phase-summary",
						ok: false,
						text: `✖ workflow-${terminal}: ${id}${
							snap.workflow!.haltReason ? ` — ${snap.workflow!.haltReason}` : ""
						}`,
					},
		);
	}

	return {
		wf,
		progress,
		elapsed,
		turn,
		health,
		live: liveText,
		why,
		last,
		stuck,
		logLines,
	};
}
