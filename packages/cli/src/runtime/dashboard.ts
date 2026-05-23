import { render } from "ink";
import { createElement } from "react";
import type { ReactElement } from "react";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { getWorkflowDefinition } from "@ai-whisper/broker";
import {
	gridCapacity,
	Wall,
	Inspector,
	DashboardApp,
	type InspectorSection,
} from "./dashboard-view.js";
import type { Viewport } from "./relay-view.js";
import { logViewportHeight } from "./relay-view.js";
import {
	buildWallState,
	buildInspectorState,
	selectWallPage,
	type InspectorState,
	type PhaseRunRef,
	type RelayViewSnapshot,
} from "./dashboard-state.js";

// Host-only pid-liveness probe (Bug C). Lives here, NOT in the pure builders,
// so computeLiveness stays deterministic. Absent pid → false (conservative, so
// the signal never masks a real hang). EPERM means the process exists but is
// not signalable by us → treat as alive.
export function probeMountAlive(
	pid: number | null,
	kill: (pid: number, signal: number) => void = (p, s) => {
		process.kill(p, s);
	},
): boolean {
	if (pid == null) return false;
	try {
		kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

// Build a per-agent mountAlive resolver from a collab's session attachments.
// The mounted attachment carries the provider pid recorded at mount. Absent
// attachment/pid → mountAlive=false (conservative). Probes process.kill here
// (host), keeping the pure builders deterministic.
export function buildMountAliveByAgent(
	attachments: Array<{ agentType: string; pid: number | null }>,
): (agentType: string) => boolean {
	const pidByAgent = new Map<string, number | null>();
	for (const a of attachments) {
		// Prefer a non-null pid if multiple attachment kinds exist for the agent.
		const existing = pidByAgent.get(a.agentType);
		if (existing == null) pidByAgent.set(a.agentType, a.pid);
	}
	return (agentType: string) =>
		probeMountAlive(pidByAgent.has(agentType) ? (pidByAgent.get(agentType) ?? null) : null);
}

const DEFAULT_WINDOW_MS = 1_800_000;
function resolveDashboardWindowMs(): number {
	const raw = process.env.AI_WHISPER_DASHBOARD_WINDOW_MS;
	if (raw === undefined) return DEFAULT_WINDOW_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_MS;
}

type Mode = "wall" | "inspector";

export function createDashboardRuntime(input: {
	broker: BrokerRuntime;
	dashboardId: string;
	stdout: NodeJS.WritableStream;
	pollIntervalMs?: number;
}) {
	let stopping = false;
	let started = false;
	let consecutivePollErrors = 0;
	let lastPollError: string | null = null;
	let mode: Mode = "wall";
	let inspectorCollabId: string | null = null;
	let inspectorWorkflowId: string | null = null;
	let inspectorType: string | null = null;
	let inspectorLabel = "";
	let inspectorSection: InspectorSection = "live";
	let wallPage = 0;
	let wallSelected = 0;
	let lastPaneCollabIds: string[] = [];
	const viewport: Viewport = { offset: 0, follow: true };
	let loopResolve!: () => void;
	const loopDone = new Promise<void>((r) => (loopResolve = r));
	const cols = (input.stdout as { columns?: number }).columns ?? 120;
	const rows = (input.stdout as { rows?: number }).rows ?? 40;
	const windowMs = resolveDashboardWindowMs();

	function toPhaseRuns(
		raw: Array<{
			phaseRunId: string;
			phaseIndex: number;
			phaseName: string;
			startedAt: string;
			endedAt: string | null;
			outcome: string | null;
		}>,
	): PhaseRunRef[] {
		return raw.map((p) => ({
			phaseRunId: p.phaseRunId,
			phaseIndex: p.phaseIndex,
			phaseName: p.phaseName,
			startedAt: p.startedAt,
			endedAt: p.endedAt,
			outcome: p.outcome,
		}));
	}

	function inspectorState(): InspectorState | null {
		if (!inspectorCollabId) return null;
		const c = input.broker.control;
		const isoNow = new Date().toISOString();
		const collabId = inspectorCollabId;
		// Scope the tail to the focused run (or to manual relays only) so a
		// noisier sibling run on the same collab can't crowd out — or worse,
		// starve — the rows we display. See relay-handoff-repository
		// `RelayHandoffWorkflowFilter`.
		const handoffs = c.listRelayHandoffs(collabId, 200, {
			workflowFilter: inspectorWorkflowId
				? { workflowId: inspectorWorkflowId }
				: { manualOnly: true },
		});
		const wf = inspectorWorkflowId ? c.getWorkflow(inspectorWorkflowId) : null;
		const phaseRaw = inspectorWorkflowId
			? c.getWorkflowPhaseRuns(inspectorWorkflowId)
			: [];
		const phaseRuns = toPhaseRuns(phaseRaw);
		const curRun =
			phaseRuns.find((p) => p.endedAt === null) ??
			phaseRuns[phaseRuns.length - 1] ??
			null;
		const curRunChainId = curRun
			? ((phaseRaw.find((p) => p.phaseRunId === curRun.phaseRunId) as
					| { chainId?: string }
					| undefined)?.chainId ?? null)
			: null;
		const chain = curRunChainId ? c.getRelayChain(curRunChainId) : null;
		const turn = c.getRelayTurnState(collabId, isoNow);
		const sessions = c.listSessions(collabId);
		// Per-agent pid-liveness (Bug C): probe each mounted agent's recorded pid.
		const mountAliveOf = buildMountAliveByAgent(
			c.listSessionAttachments(collabId),
		);
		const def = inspectorType ? getWorkflowDefinition(inspectorType) : null;
		const phaseMaxRounds: Record<number, number> = {};
		if (def)
			def.phases.forEach((ph, i) => {
				phaseMaxRounds[i] = ph.maxRounds;
			});
		const chainId = chain?.chainId ?? null;
		// When there's no chain to scope by (brand-new workflow with no phase
		// yet, or a manual relay pane), the fallback queries must still be
		// run-scoped — otherwise they pull diagnostics from sibling runs on
		// the same collab. Same defect class as the listRelayHandoffs filter.
		const diagFilter = inspectorWorkflowId
			? { workflowId: inspectorWorkflowId }
			: ({ manualOnly: true } as const);
		const evalDiags = chainId
			? c.listEvaluatorDiagnosticsByCollabAndChain(collabId, chainId, 50)
			: c.listEvaluatorDiagnosticsByCollab(collabId, 50, {
					workflowFilter: diagFilter,
				});
		const capDiags = chainId
			? c.listCaptureDiagnosticsByCollabAndChain(collabId, chainId, 50)
			: c.listCaptureDiagnosticsByCollab(collabId, 50, {
					workflowFilter: diagFilter,
				});
		const costRows = c.listRunCostRows(collabId, inspectorWorkflowId);
		// Bug B: the full workflow run history for this collab (newest-first),
		// surfaced in the Inspector with the currently-inspected one flagged.
		const workflows = c.listWorkflowsForCollab(collabId);

		let activeStep: string | null = null;
		if (curRun) {
			for (let i = handoffs.length - 1; i >= 0; i--) {
				if (handoffs[i]!.phaseRunId === curRun.phaseRunId) {
					activeStep = handoffs[i]!.handoffStep;
					break;
				}
			}
		}
		const fallbackStep =
			def && curRun
				? (def.phases[curRun.phaseIndex]?.initialHandoffStep ?? null)
				: null;
		const lastActivityAt = handoffs.reduce<string | null>((mx, h) => {
			const t = h.lastActivityAt ?? h.createdAt;
			return mx === null || t > mx ? t : mx;
		}, null);

		const snapshot: RelayViewSnapshot = {
			now: isoNow,
			idleThresholdMs: 30_000,
			workflow: wf
				? {
						workflowId: wf.workflowId,
						workflowType: wf.workflowType,
						name: wf.name,
						status: wf.status,
						createdAt: wf.createdAt,
						haltReason: wf.haltReason,
					}
				: null,
			phaseRuns,
			currentPhaseRunId: curRun?.phaseRunId ?? null,
			currentStep: activeStep ?? fallbackStep,
			totalPhases: def ? def.phases.length : phaseRuns.length,
			chain: chain
				? {
						currentRound: chain.currentRound,
						maxRounds: chain.maxRounds,
						status: chain.status,
					}
				: null,
			turn: {
				turnOwner: turn.turnOwner,
				waitingAgent: turn.waitingAgent ?? null,
				handoffState: turn.handoffState,
			},
			sessions: sessions.map((s) => ({
				agentType: s.agentType,
				healthState: s.healthState,
				mountAlive: mountAliveOf(s.agentType),
			})),
			lastActivityAt,
			handoffs,
		};
		const focusedPhaseRunId = curRun?.phaseRunId ?? null;
		return buildInspectorState({
			snapshot,
			phaseRuns,
			phaseMaxRounds,
			costRows,
			workflowCreatedAt: wf?.createdAt ?? null,
			chainId,
			evidenceHandoffs: handoffs.filter(
				(h) => h.phaseRunId === focusedPhaseRunId,
			),
			evaluatorDiags: evalDiags.map((d) => ({
				verdict: d.verdict,
				confidence: d.confidence,
				reason: d.reason,
				outcome: d.outcome,
			})),
			captureDiags: capDiags.map((d) => ({
				captureStatus: d.captureStatus,
				turnConfidence: d.turnConfidence,
			})),
			focusedPhaseRunId,
			workflows,
			selectedWorkflowId: inspectorWorkflowId,
		});
	}

	function node(): ReactElement {
		const c = input.broker.control;
		const isoNow = new Date().toISOString();
		if (mode === "inspector" && inspectorCollabId) {
			const st = inspectorState();
			if (st) {
				return createElement(Inspector, {
					state: st,
					section: inspectorSection,
					viewport,
					cols,
					rows,
					label: inspectorLabel,
					workflowType: inspectorType,
				});
			}
		}

		const summaries = c.listActiveCollabSummaries(windowMs, isoNow);
		const capacity = gridCapacity(cols, rows);
		const sel = selectWallPage({
			summaries,
			capacity,
			page: wallPage,
			selected: wallSelected,
		});
		const snapshots: Record<
			string,
			{
				handoffs: ReturnType<typeof c.listRelayHandoffs>;
				phaseRuns: PhaseRunRef[];
				totalPhases: number;
			}
		> = {};
		for (const s of sel.pageSummaries) {
			// Each pane represents ONE run on this collab — either a workflow
			// instance (`s.workflowId`) or the manual relay slice. Scope the
			// tail so we don't tail-mix sibling runs on the same collab.
			const handoffs = c.listRelayHandoffs(s.collabId, 8, {
				workflowFilter: s.workflowId
					? { workflowId: s.workflowId }
					: { manualOnly: true },
			});
			const phaseRaw = s.workflowId
				? c.getWorkflowPhaseRuns(s.workflowId)
				: [];
			const def = s.workflowType ? getWorkflowDefinition(s.workflowType) : null;
			snapshots[s.collabId] = {
				handoffs,
				phaseRuns: toPhaseRuns(phaseRaw),
				totalPhases: def ? def.phases.length : 0,
			};
			// Per-agent pid-liveness (Bug C) for the VISIBLE pane only (bounded
			// cost): probe each agent's recorded mount pid and attach mountAlive
			// to that agent's sessions[] entry so the Wall's computeLiveness can
			// distinguish a hung worker from a live long-running step.
			const mountAliveOf = buildMountAliveByAgent(
				c.listSessionAttachments(s.collabId),
			);
			s.sessions = s.sessions.map((sess) => ({
				...sess,
				mountAlive: mountAliveOf(sess.agentType),
			}));
		}
		const wallState = buildWallState({
			summaries,
			now: isoNow,
			idleThresholdMs: 30_000,
			capacity,
			page: wallPage,
			selected: wallSelected,
			snapshots,
		});
		wallPage = wallState.page;
		wallSelected = wallState.selected;
		lastPaneCollabIds = wallState.panes.map((p) => p.collabId);
		return createElement(Wall, { state: wallState, cols, rows });
	}

	const ink = render(
		createElement(DashboardApp, { node: node(), onKey: handleKey }),
		{
			stdout: input.stdout as NodeJS.WriteStream,
			exitOnCtrlC: false,
		},
	);

	function rerender() {
		try {
			ink.rerender(
				createElement(DashboardApp, { node: node(), onKey: handleKey }),
			);
		} catch (err) {
			// Surface rerender failures through pollHealth instead of swallowing
			// them — a silent catch here masked an Inspector section-change bug
			// that left the previous frame on screen while host state moved on.
			consecutivePollErrors += 1;
			lastPollError = err instanceof Error ? err.message : String(err);
		}
	}

	function handleKey(ev: {
		upArrow?: boolean;
		downArrow?: boolean;
		escape?: boolean;
		key?: string;
	}) {
		if (mode === "wall") {
			if (ev.upArrow || ev.key === "k")
				wallSelected = Math.max(0, wallSelected - 1);
			else if (ev.downArrow || ev.key === "j") wallSelected = wallSelected + 1;
			else if (ev.key === "[") wallPage = Math.max(0, wallPage - 1);
			else if (ev.key === "]") wallPage = wallPage + 1;
			else if (ev.key === "\r" || ev.key === "\n") {
				const collabId = lastPaneCollabIds[wallSelected];
				if (collabId) {
					const sums = input.broker.control.listActiveCollabSummaries(
						windowMs,
						new Date().toISOString(),
					);
					const s = sums.find((x) => x.collabId === collabId);
					inspectorCollabId = collabId;
					inspectorWorkflowId = s?.workflowId ?? null;
					inspectorType = s?.workflowType ?? null;
					inspectorLabel = s?.label ?? collabId;
					inspectorSection = "live";
					viewport.offset = 0;
					viewport.follow = true;
					mode = "inspector";
				}
			} else if (ev.key === "q") stopping = true;
		} else {
			if (ev.key === "1") inspectorSection = "live";
			else if (ev.key === "2") inspectorSection = "timeline";
			else if (ev.key === "3") inspectorSection = "evidence";
			else if (ev.key === "4") inspectorSection = "cost";
			else if (ev.escape) mode = "wall";
			else if (ev.key === "q") stopping = true;
			else if (inspectorSection === "live") {
				const visibleH = logViewportHeight(rows);
				const linesLen = inspectorState()?.live.logLines.length ?? 0;
				const tailStart = Math.max(0, linesLen - visibleH);
				if (ev.upArrow) {
					viewport.follow = false;
					viewport.offset = Math.min(tailStart, viewport.offset + 1);
				} else if (ev.downArrow) {
					viewport.follow = false;
					viewport.offset = Math.max(0, viewport.offset - 1);
				} else if (ev.key === "g") {
					viewport.follow = false;
					viewport.offset = tailStart;
				} else if (ev.key === "G") {
					viewport.follow = true;
					viewport.offset = 0;
				} else if (ev.key === "f") {
					viewport.follow = !viewport.follow;
					if (viewport.follow) viewport.offset = 0;
				}
			}
		}
		rerender();
	}

	// The dashboard is observe-only and aggregates across ALL collabs — it is
	// NOT attached to a specific collab the way relay-monitor is. We do NOT
	// call registerRelayMonitor / heartbeatRelayMonitor here: those APIs
	// validate the collabId against the `collab` table and would throw
	// "Unknown collab: dashboard" since no such row exists. The dashboardId
	// is still kept as an instance handle for logs + double-start guarding.
	function poll() {
		rerender();
		consecutivePollErrors = 0;
		lastPollError = null;
	}

	return {
		start() {
			if (started) return;
			started = true;
			void (async () => {
				while (!stopping) {
					try {
						poll();
					} catch (err) {
						consecutivePollErrors += 1;
						lastPollError = err instanceof Error ? err.message : String(err);
					}
					await new Promise((r) => setTimeout(r, input.pollIntervalMs ?? 250));
				}
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
		__mode: () => mode,
		__section: () => inspectorSection,
		__handleKey: handleKey,
		__viewport: viewport,
		__wallSelected: () => wallSelected,
		__pollHealth: () => ({
			consecutiveErrors: consecutivePollErrors,
			lastError: lastPollError,
		}),
	};
}
