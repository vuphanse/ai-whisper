import { render } from "ink";
import { createElement } from "react";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { getWorkflowDefinition } from "@ai-whisper/broker";
import type { RelayHandoffCursor, RelayHandoffLogRow } from "@ai-whisper/broker";
import { STATUS_ROWS, type Viewport } from "./relay-view.js";
import { RelayViewApp } from "./relay-view-input.js";
import {
	buildRelayViewState,
	type RelayViewSnapshot,
} from "./relay-view-state.js";

const BUFFER_CAP = 2000;
// STATUS_ROWS is imported from relay-view.js (single source of truth — it is
// derived there from STATUS_BLOCK_ROWS + border; do NOT re-declare it here).

const DEFAULT_IDLE_THRESHOLD_MS = 30_000;

function resolveIdleThresholdMs(): number {
	const raw = process.env.AI_WHISPER_IDLE_THRESHOLD_MS;
	if (raw === undefined) return DEFAULT_IDLE_THRESHOLD_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_THRESHOLD_MS;
}

export function createRelayMonitorRuntime(input: {
	broker: BrokerRuntime;
	collabId: string;
	monitorId: string;
	stdout: NodeJS.WritableStream;
	pollIntervalMs?: number;
}) {
	let stopping = false;
	let started = false;
	let terminalReached = false; // set true once a terminal workflow is rendered
	let cursor: RelayHandoffCursor | undefined;
	let consecutivePollErrors = 0;
	let lastPollError: string | null = null;
	const buffer: RelayHandoffLogRow[] = [];
	const viewport: Viewport = { offset: 0, follow: true };
	let loopResolve!: () => void;
	const loopDone = new Promise<void>((r) => (loopResolve = r));

	const cols = (input.stdout as { columns?: number }).columns ?? 120;
	const rows = (input.stdout as { rows?: number }).rows ?? 40;

	const ink = render(createElement(RelayViewApp, frameProps()), {
		stdout: input.stdout as NodeJS.WriteStream,
		exitOnCtrlC: false,
	});

	function handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }) {
		const visibleH = Math.max(1, rows - STATUS_ROWS);
		const linesLen = frameProps().state.logLines.length;
		const tailStart = Math.max(0, linesLen - visibleH);
		// offset = number of lines scrolled UP from the tail (matches
		// LogViewport's `start = clamp(tailStart - offset)`). offset 0 = tail
		// (newest); offset = tailStart = oldest. Leaving follow keeps us at
		// the tail (offset 0); ↑ increases offset (scroll up), ↓ decreases it
		// (scroll back toward newest). No seed step is needed.
		if (ev.upArrow) {
			viewport.follow = false;
			viewport.offset = Math.min(tailStart, viewport.offset + 1);
		} else if (ev.downArrow) {
			viewport.follow = false;
			viewport.offset = Math.max(0, viewport.offset - 1);
		} else if (ev.key === "g") {
			viewport.follow = false;
			viewport.offset = tailStart; // jump to the oldest buffered line
		} else if (ev.key === "G") {
			viewport.follow = true;
			viewport.offset = 0; // resume following the tail
		} else if (ev.key === "f") {
			viewport.follow = !viewport.follow;
			if (viewport.follow) viewport.offset = 0;
		} else if (ev.key === "q") {
			stopping = true;
		}
		try {
			ink.rerender(createElement(RelayViewApp, frameProps()));
		} catch {
			/* ignore */
		}
	}

	function frameProps() {
		const c = input.broker.control;
		const turn = c.getRelayTurnState(input.collabId, new Date().toISOString());
		const sessions = c.listSessions(input.collabId);
		// Resolve the workflow to render: the running one, else the most-recent
		// terminal one (so a done/halted/canceled workflow still shows its final
		// state — spec §8 — before the host exits).
		const allWorkflows =
			typeof c.listWorkflows === "function"
				? c.listWorkflows({ collabId: input.collabId })
				: [];
		const running = allWorkflows.find((w) => w.status === "running") ?? null;
		// listWorkflows is ORDER BY created_at DESC → index 0 is the NEWEST.
		const wfRow = running ?? allWorkflows[0] ?? null;
		// terminalReached drives the host to exit after rendering the final frame.
		terminalReached =
			wfRow != null && wfRow.status !== "running" ? true : terminalReached;
		let snap: RelayViewSnapshot = {
			now: new Date().toISOString(),
			idleThresholdMs: resolveIdleThresholdMs(),
			workflow: null,
			phaseRuns: [],
			currentPhaseRunId: null,
			currentStep: null,
			totalPhases: 0,
			chain: null,
			turn: {
				turnOwner: turn.turnOwner,
				waitingAgent: turn.waitingAgent ?? null,
				handoffState: turn.handoffState,
			},
			sessions: sessions.map((s) => ({
				agentType: s.agentType,
				healthState: s.healthState,
			})),
			lastActivityAt: buffer[buffer.length - 1]?.createdAt ?? null,
			handoffs: buffer,
		};
		if (wfRow) {
			const wf = c.getWorkflow(wfRow.workflowId);
			const phaseRuns = c.getWorkflowPhaseRuns(wfRow.workflowId);
			const curRun = phaseRuns.find((p) => p.endedAt === null) ?? null;
			const chain = curRun ? c.getRelayChain(curRun.chainId) : null;
			const def = getWorkflowDefinition(wfRow.workflowType);
			const status = (wf?.status ?? wfRow.status) as
				| "running"
				| "done"
				| "halted"
				| "canceled";
			snap = {
				...snap,
				workflow: {
					workflowId: wfRow.workflowId,
					workflowType: wfRow.workflowType,
					name: (wf?.name ?? wfRow.name) ?? null,
					status,
					createdAt: wf?.createdAt ?? new Date().toISOString(),
					haltReason: wf?.haltReason ?? null,
				},
				phaseRuns: phaseRuns.map((p) => ({
					phaseRunId: p.phaseRunId,
					phaseIndex: p.phaseIndex,
					phaseName: p.phaseName,
					startedAt: p.startedAt,
					endedAt: p.endedAt,
					outcome: p.outcome ?? null,
				})),
				currentPhaseRunId: curRun?.phaseRunId ?? null,
				currentStep:
					def?.phases[curRun?.phaseIndex ?? -1]?.initialHandoffStep ?? null,
				totalPhases: def ? def.phases.length : 0,
				chain: chain
					? {
							currentRound: chain.currentRound,
							maxRounds: chain.maxRounds,
							status: chain.status,
						}
					: null,
			};
		}
		const state = buildRelayViewState(snap);
		return { state, viewport, rows, cols, onKey: handleKey };
	}

	function poll() {
		const c = input.broker.control;
		c.heartbeatRelayMonitor({
			collabId: input.collabId,
			monitorId: input.monitorId,
			now: new Date().toISOString(),
		});
		const fresh = c.listRelayHandoffs(input.collabId, cursor);
		if (fresh.length > 0) {
			for (const h of fresh) buffer.push(h);
			if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
			const last = fresh[fresh.length - 1]!;
			cursor = { createdAt: last.createdAt, handoffId: last.handoffId };
		}
		ink.rerender(createElement(RelayViewApp, frameProps()));
		// Spec §8: once the final (terminal) frame has been rendered, exit clean.
		if (terminalReached) stopping = true;
		// Reset poll-error counters on success (Task-10 seam).
		consecutivePollErrors = 0;
		lastPollError = null;
	}

	return {
		start() {
			if (started) return;
			started = true;
			input.broker.control.registerRelayMonitor({
				collabId: input.collabId,
				monitorId: input.monitorId,
				now: new Date().toISOString(),
			});
			void (async () => {
				while (!stopping) {
					try {
						poll();
					} catch (err) {
						// read-only; degrade silently, keep last frame
						consecutivePollErrors += 1;
						lastPollError = err instanceof Error ? err.message : String(err);
					}
					await new Promise((r) =>
						setTimeout(r, input.pollIntervalMs ?? 250),
					);
				}
				// Flush the final (terminal) frame before resolving so a
				// self-exit (no stop() call) still emits the last render.
				ink.unmount();
				loopResolve();
			})();
		},
		async stop() {
			stopping = true;
			await loopDone;
			ink.unmount();
		},
		waitUntilStopped() {
			return loopDone;
		},
		// exposed for input handling (Task 10)
		__viewport: viewport,
		__handleKey: handleKey,
		__statusRows: STATUS_ROWS,
		__bufferLen: () => buffer.length,
		__pollHealth: () => ({ consecutiveErrors: consecutivePollErrors, lastError: lastPollError }),
	};
}
