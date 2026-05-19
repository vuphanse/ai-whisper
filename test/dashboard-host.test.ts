import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createDashboardRuntime } from "../packages/cli/src/runtime/dashboard.ts";

function fakeBroker(summaries: unknown[] = []) {
	const control = {
		registerRelayMonitor: vi.fn(),
		heartbeatRelayMonitor: vi.fn(),
		listActiveCollabSummaries: vi.fn((_w: number, _n?: string) =>
			(summaries as Array<Record<string, unknown>>).map((s) => ({ ...s })),
		),
		listRelayHandoffs: vi.fn(() => []),
		getWorkflow: vi.fn(() => null),
		getWorkflowPhaseRuns: vi.fn(() => []),
		getRelayChain: vi.fn(() => null),
		getRelayTurnState: vi.fn(() => ({ turnOwner: "none", waitingAgent: null, handoffState: "idle" })),
		listSessions: vi.fn(() => []),
		listEvaluatorDiagnosticsByCollab: vi.fn(() => []),
		listEvaluatorDiagnosticsByCollabAndChain: vi.fn(() => []),
		listCaptureDiagnosticsByCollab: vi.fn(() => []),
		listCaptureDiagnosticsByCollabAndChain: vi.fn(() => []),
		listRunCostRows: vi.fn(() => []),
	};
	return { db: {}, control };
}
function S(p: Record<string, unknown>) {
	return {
		collabId: "c1", label: "oauth", workflowId: "wf", workflowType: "spec-driven-development",
		workflowStatus: "running", currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
		currentRound: 3, maxRounds: 5, chainStatus: "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [{ agentType: "codex", healthState: "healthy" }], lastActivityAt: "2026-05-20T00:00:00.000Z", ...p,
	};
}

describe("dashboard host", () => {
	it("renders the Wall and stops cleanly", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 50));
		await m.stop();
		expect(buf).toContain("oauth");
		expect(buf).toContain("page 1/");
	});

	it("Enter switches to Inspector, Esc back; q stops", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>; waitUntilStopped(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; key?: string }): void;
			__mode(): string;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		expect(m.__mode()).toBe("wall");
		m.__handleKey({ key: "\r" }); // Enter
		expect(m.__mode()).toBe("inspector");
		m.__handleKey({ escape: true }); // Esc
		expect(m.__mode()).toBe("wall");
		m.__handleKey({ key: "q" });
		await Promise.race([
			m.waitUntilStopped(),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("q did not stop")), 500)),
		]);
	});

	it("Inspector ignores non-Esc empty-key events (Left/Right/Tab don't bounce to Wall)", async () => {
		// Regression: ink's useInput collapses many non-printable keys (Left,
		// Right, Tab, PageUp, Home, …) to inputCh = "". Earlier code treated
		// `ev.key === ""` as Esc and silently exited Inspector on any of them.
		// Now Esc is forwarded as `escape: true`; the empty-key events must be
		// no-ops in Inspector.
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: fakeBroker([S({})]) as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; key?: string }): void;
			__mode(): string;
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → Inspector
		expect(m.__mode()).toBe("inspector");
		m.__handleKey({ key: "" }); // Left/Right/Tab/PageUp/Home — all surface as ""
		expect(m.__mode()).toBe("inspector"); // MUST still be Inspector
		m.__handleKey({ escape: true }); // explicit Esc now exits
		expect(m.__mode()).toBe("wall");
		await m.stop();
	});

	it("survives a broker throw on poll (degraded but alive)", async () => {
		const broker = fakeBroker([S({})]);
		let n = 0;
		broker.control.listActiveCollabSummaries = vi.fn(() => {
			n += 1;
			if (n === 2) throw new Error("db locked");
			return [S({})];
		}) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(buf).toContain("oauth");
		expect(n).toBeGreaterThan(2);
	});

	it("double start() is a no-op", async () => {
		const broker = fakeBroker([S({})]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		await m.stop();
		expect((broker.control.registerRelayMonitor as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
	});

	it("F1: fetches per-collab snapshots ONLY for the visible page", async () => {
		const many = Array.from({ length: 5 }, (_, i) =>
			S({ collabId: `c${i}`, lastActivityAt: `2026-05-20T00:0${9 - i}:00.000Z` }),
		);
		const broker = fakeBroker(many);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 40; // gridCapacity(40,10) = 1*2 = 2
		(stdout as unknown as { rows: number }).rows = 10;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 });
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		const fetched = new Set(
			(broker.control.listRelayHandoffs as { mock: { calls: unknown[][] } }).mock.calls.map((cargs) => cargs[0]),
		);
		expect(fetched.size).toBeGreaterThan(0);
		expect(fetched.size).toBeLessThanOrEqual(2); // page capacity, NEVER all 5
	});

	it("F2: Inspector Live shows the ACTIVE step (latest handoff), not the phase initial", async () => {
		const phaseRuns = [{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1", startedAt: "2026-05-20T00:00:00.000Z", endedAt: null, outcome: null }];
		const handoffs = [
			{ handoffId: "h1", createdAt: "2026-05-20T00:01:00.000Z", collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement", workflowId: "wf1", phaseRunId: "pr1", handbackText: "x", evaluatorVerdict: "delivered", evaluatorConfidence: 0.6, evaluatorReason: "r", lastActivityAt: "2026-05-20T00:01:00.000Z" },
			{ handoffId: "h2", createdAt: "2026-05-20T00:05:00.000Z", collabId: "c1", senderAgent: "claude", targetAgent: "codex", status: "handed_back", captureStatus: "ok", chainId: "ch1", roundNumber: 3, handoffStep: "review", workflowId: "wf1", phaseRunId: "pr1", handbackText: null, evaluatorVerdict: "findings", evaluatorConfidence: 0.4, evaluatorReason: "r2", lastActivityAt: "2026-05-20T00:06:30.000Z" },
		];
		const broker = fakeBroker([S({ collabId: "c1", workflowId: "wf1", workflowType: "spec-driven-development", phaseIndex: 1, currentRound: 3, maxRounds: 5, chainStatus: "active" })]);
		broker.control.listRelayHandoffs = vi.fn(() => handoffs.map((h) => ({ ...h }))) as never;
		broker.control.getWorkflow = vi.fn(() => ({ workflowId: "wf1", workflowType: "spec-driven-development", name: "oauth", status: "running", createdAt: "2026-05-20T00:00:00.000Z", haltReason: null })) as never;
		broker.control.getWorkflowPhaseRuns = vi.fn(() => phaseRuns.map((p) => ({ ...p }))) as never;
		broker.control.getRelayChain = vi.fn(() => ({ chainId: "ch1", currentRound: 3, maxRounds: 5, status: "active" })) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as { start(): void; stop(): Promise<void>; __handleKey(ev: { key?: string }): void };
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → Inspector (live)
		await new Promise((r) => setTimeout(r, 20));
		await m.stop();
		expect(buf).toContain("Step review"); // latest handoff step (h2)
		expect(buf).not.toContain("Step implement"); // NOT plan-writing's initialHandoffStep
	});

	it("F3: Inspector Live g/G/↑/f scroll-follow behaves like relay-monitor", async () => {
		const broker = fakeBroker([S({ collabId: "c1" })]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createDashboardRuntime({ broker: broker as never, dashboardId: "d1", stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10 }) as never as {
			start(): void; stop(): Promise<void>;
			__handleKey(ev: { upArrow?: boolean; downArrow?: boolean; key?: string }): void;
			__viewport: { offset: number; follow: boolean };
		};
		m.start();
		await new Promise((r) => setTimeout(r, 30));
		m.__handleKey({ key: "\r" }); // Enter → inspector live
		expect(m.__viewport).toMatchObject({ offset: 0, follow: true });
		m.__handleKey({ upArrow: true });
		expect(m.__viewport.follow).toBe(false);
		expect(m.__viewport.offset).toBeGreaterThanOrEqual(0);
		m.__handleKey({ key: "g" });
		expect(m.__viewport.follow).toBe(false); // jump to oldest
		m.__handleKey({ key: "G" });
		expect(m.__viewport).toMatchObject({ offset: 0, follow: true }); // back to tail
		m.__handleKey({ key: "f" });
		expect(m.__viewport.follow).toBe(false); // toggle off
		await m.stop();
	});
});
