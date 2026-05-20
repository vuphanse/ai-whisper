// Integration smoke for createDashboardRuntime against a REAL broker (no fake).
//
// Why this exists: the unit suite in `dashboard-host.test.ts` uses a fakeBroker
// whose control methods are vi.fn() stubs that don't validate inputs. The real
// broker validates collabId on registerRelayMonitor/heartbeatRelayMonitor and
// throws "Unknown collab: dashboard" — that defect rendered the TUI invisible
// in production but passed every fake-broker test. This file boots a real
// createBrokerRuntime against a temp sqlite, seeds a minimal collab, and
// confirms the dashboard mounts + polls + stops without throwing.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createDashboardRuntime } from "../packages/cli/src/runtime/dashboard.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-dash-int-"));
	// Use an ephemeral port we don't actually `start()` — runCollabDashboard
	// never listens, but the schema requires a positive port number.
	return createBrokerRuntime({
		sqlitePath: join(dir, "broker.sqlite"),
		host: "127.0.0.1",
		port: 4711,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

function seedMinimal(broker: ReturnType<typeof newBroker>) {
	// Anchor timestamps relative to actual wall-clock now so the seeded collab
	// stays inside the dashboard's recency window (default 30 min).
	const now = new Date().toISOString();
	broker.db
		.prepare(
			`INSERT INTO collab
			 (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
			 VALUES ('c_int','/tmp/aiw-int','int',?, ?, ?, 0, 5)`,
		)
		.run("active", now, now);
	broker.db
		.prepare(
			`INSERT INTO relay_handoff
			 (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,
			  last_activity_at,capture_status,handback_text)
			 VALUES ('h_int','c_int','codex','claude','req','handed_back', ?, ?, 'ok','done')`,
		)
		.run(now, now);
}

describe("dashboard host (real broker integration)", () => {
	it("mounts, polls, and stops without throwing against a real broker", async () => {
		const broker = newBroker();
		try {
			seedMinimal(broker);
			const stdout = new PassThrough();
			(stdout as unknown as { columns: number }).columns = 100;
			(stdout as unknown as { rows: number }).rows = 24;
			let buf = "";
			stdout.on("data", (c) => (buf += String(c)));

			const m = createDashboardRuntime({
				broker,
				dashboardId: "dash_integration",
				stdout: stdout as unknown as NodeJS.WritableStream,
				pollIntervalMs: 10,
			});
			m.start();
			await new Promise((r) => setTimeout(r, 60));
			await m.stop();

			// Frames hit the PassThrough — at minimum the footer should appear
			// (proves the wall path didn't error during render).
			expect(buf).toContain("int"); // the seeded label
			expect(buf).toContain("page 1/");
			// Poll health must show NO consecutive errors (the production bug
			// raised "Unknown collab: dashboard" on the very first poll/start).
			const health = (
				m as unknown as { __pollHealth: () => { consecutiveErrors: number; lastError: string | null } }
			).__pollHealth();
			expect(health.lastError).toBeNull();
			expect(health.consecutiveErrors).toBe(0);
		} finally {
			void broker.stop();
		}
	});

	it("renders the empty-wall state cleanly against a real broker with no collabs", async () => {
		const broker = newBroker();
		try {
			// No seed — empty DB. Wall must render the empty state without
			// touching registerRelayMonitor (which would throw on "dashboard").
			const stdout = new PassThrough();
			(stdout as unknown as { columns: number }).columns = 100;
			(stdout as unknown as { rows: number }).rows = 24;
			let buf = "";
			stdout.on("data", (c) => (buf += String(c)));

			const m = createDashboardRuntime({
				broker,
				dashboardId: "dash_int_empty",
				stdout: stdout as unknown as NodeJS.WritableStream,
				pollIntervalMs: 10,
			});
			m.start();
			await new Promise((r) => setTimeout(r, 40));
			await m.stop();

			expect(buf).toContain("no active collabs");
			const health = (
				m as unknown as { __pollHealth: () => { consecutiveErrors: number; lastError: string | null } }
			).__pollHealth();
			expect(health.lastError).toBeNull();
		} finally {
			void broker.stop();
		}
	});
});
