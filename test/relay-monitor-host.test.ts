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
});
