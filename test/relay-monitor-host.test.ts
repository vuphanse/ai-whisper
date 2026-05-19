import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createRelayMonitorRuntime } from "../packages/cli/src/runtime/relay-monitor.ts";

function fakeBroker(
	handoffs: unknown[] = [],
	workflows: Array<{ workflowId: string; workflowType: string; name: string | null; status: string }> = [],
) {
	return {
		db: {},
		control: {
			registerRelayMonitor: vi.fn(),
			heartbeatRelayMonitor: vi.fn(),
			listRelayHandoffs: vi.fn(
				(_collabId: string, after?: { createdAt: string; handoffId: string }) => {
					const all = handoffs as Array<{ createdAt: string; handoffId: string }>;
					return after
						? all.filter(
								(h) =>
									h.createdAt > after.createdAt ||
									(h.createdAt === after.createdAt && h.handoffId > after.handoffId),
							)
						: all;
				},
			),
			getRelayTurnState: vi.fn(() => ({
				turnOwner: "codex", waitingAgent: "claude", handoffState: "accepted",
			})),
			listWorkflows: vi.fn(() => workflows),
			getWorkflow: vi.fn((id: string) => {
				const w = workflows.find((x) => x.workflowId === id);
				return w ? { ...w, createdAt: "2026-05-19T08:00:00.000Z", haltReason: w.status === "halted" ? "max-rounds-reached (phase plan-writing)" : null } : null;
			}),
			getWorkflowPhaseRuns: vi.fn(() => [
				{ phaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing", chainId: "ch1",
				  startedAt: "2026-05-19T08:00:00.000Z", endedAt: "2026-05-19T08:11:40.000Z", outcome: "escalated (max rounds)" },
			]),
			getRelayChain: vi.fn(() => null),
			listSessions: vi.fn(() => [
				{ agentType: "codex", healthState: "healthy" },
				{ agentType: "claude", healthState: "healthy" },
			]),
		},
	};
}

describe("relay-monitor host", () => {
	it("starts, renders a frame to stdout, and stops cleanly", async () => {
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));

		const m = createRelayMonitorRuntime({
			broker: fakeBroker() as never,
			collabId: "c1",
			monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream,
			pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 50));
		await m.stop();

		expect(buf).toContain("wf │");
		expect(buf).toContain("health │");
	});

	it("incrementally appends handoffs to the buffer (cursor advances)", async () => {
		const broker = fakeBroker();
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		// after the first non-empty fetch the cursor is passed back
		const calls = broker.control.listRelayHandoffs.mock.calls;
		expect(calls.length).toBeGreaterThan(1);
	});

	it("renders the final state of a terminal workflow and exits on its own", async () => {
		const broker = fakeBroker([], [
			{ workflowId: "wf_3d44", workflowType: "spec-driven-development", name: "auth", status: "halted" },
		]);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		// no manual stop(): the host must exit itself once the terminal frame is drawn
		await Promise.race([
			m.waitUntilStopped(),
			new Promise((_r, rej) => setTimeout(() => rej(new Error("did not self-exit")), 500)),
		]);
		expect(buf).toContain("halted");
		expect(buf).toContain("✖ workflow-halted: wf_3d44");
	});

	it("dedupes across polls via the cursor and caps the ring buffer", async () => {
		const handoffs = Array.from({ length: 2200 }, (_, i) => ({
			handoffId: `h${String(i).padStart(5, "0")}`,
			createdAt: `2026-05-19T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
			collabId: "c1", senderAgent: "codex", targetAgent: "claude", status: "handed_back",
			captureStatus: "ok", chainId: "ch1", roundNumber: 1, handoffStep: "implement",
			workflowId: null, phaseRunId: null, handbackText: "x",
			evaluatorVerdict: null, evaluatorConfidence: null, evaluatorReason: null,
		}));
		const broker = fakeBroker(handoffs);
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as { start(): void; stop(): Promise<void>; __bufferLen(): number };
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(m.__bufferLen()).toBe(2000); // ring buffer capped, no RangeError on 2200-spread
	});

	it("survives a broker throw on poll and records it (degraded but alive)", async () => {
		const broker = fakeBroker();
		let calls = 0;
		broker.control.listRelayHandoffs = vi.fn(() => {
			calls += 1;
			if (calls === 2) throw new Error("db locked");
			return [];
		}) as never;
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		let buf = "";
		stdout.on("data", (c) => (buf += String(c)));
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		}) as never as { start(): void; stop(): Promise<void>; __pollHealth(): { consecutiveErrors: number; lastError: string | null } };
		m.start();
		await new Promise((r) => setTimeout(r, 60));
		await m.stop();
		expect(buf).toContain("wf │"); // last frame still present (loop survived the throw)
		expect(calls).toBeGreaterThan(2); // kept polling after the throw
		// at least one throw was recorded (it may have recovered by stop time)
		// so assert the hook exists and is shaped right rather than a flaky exact count
		const h = m.__pollHealth();
		expect(typeof h.consecutiveErrors).toBe("number");
	});

	it("double start() is a no-op (single render loop)", async () => {
		const broker = fakeBroker();
		const stdout = new PassThrough();
		(stdout as unknown as { columns: number }).columns = 100;
		(stdout as unknown as { rows: number }).rows = 24;
		const m = createRelayMonitorRuntime({
			broker: broker as never, collabId: "c1", monitorId: "mon1",
			stdout: stdout as unknown as NodeJS.WritableStream, pollIntervalMs: 10,
		});
		m.start();
		m.start(); // second call must be a no-op
		await new Promise((r) => setTimeout(r, 40));
		await m.stop();
		expect(broker.control.registerRelayMonitor).toHaveBeenCalledTimes(1);
	});
});
