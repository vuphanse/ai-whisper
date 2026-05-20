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
	// IDs MUST match the shared schemas — `collab_id` ~ /^collab_[a-z0-9_]+$/
	// and `session_id` ~ /^session_[a-z0-9_]+$/. The dashboard reads sessions
	// through control.listSessions → sessionSchema.parse, so malformed IDs
	// raise ZodError at runtime (this caught the smoke fixture too).
	const now = new Date().toISOString();
	broker.db
		.prepare(
			`INSERT INTO collab
			 (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
			 VALUES ('collab_int','/tmp/aiw-int','int',?, ?, ?, 0, 5)`,
		)
		.run("active", now, now);
	broker.db
		.prepare(
			`INSERT INTO workflows
			 (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,
			  current_phase_index,halt_reason,workflow_context,created_at,updated_at)
			 VALUES ('wf_int','collab_int','spec-driven-development','int wf','/tmp/spec.md','{}','running',1,NULL,'{}',?,?)`,
		)
		.run(now, now);
	broker.db
		.prepare(
			`INSERT INTO relay_chains
			 (chain_id,collab_id,status,current_round,max_rounds,terminal_handoff_id,terminal_reason,created_at,updated_at)
			 VALUES ('chain_int','collab_int','active',1,5,NULL,NULL,?,?)`,
		)
		.run(now, now);
	broker.db
		.prepare(
			`INSERT INTO workflow_phases
			 (phase_run_id,workflow_id,phase_index,phase_name,chain_id,started_at,ended_at,outcome)
			 VALUES ('pr_int','wf_int',1,'plan-writing','chain_int',?,NULL,NULL)`,
		)
		.run(now);
	broker.db
		.prepare(
			`INSERT INTO relay_handoff
			 (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,
			  last_activity_at,capture_status,handback_text,workflow_id,phase_run_id,chain_id,
			  round_number,handoff_step,evaluator_verdict,evaluator_confidence,evaluator_reason)
			 VALUES ('h_int','collab_int','codex','claude','req','handed_back', ?, ?,
			         'ok','did the thing','wf_int','pr_int','chain_int',1,'implement','delivered',0.9,'ok')`,
		)
		.run(now, now);
	broker.db
		.prepare(
			`INSERT INTO session
			 (session_id,collab_id,agent_type,registration_state,health_state,capabilities_json,registered_at,last_seen_at)
			 VALUES ('session_int_codex','collab_int','codex','registered','healthy','{}',?,?)`,
		)
		.run(now, now);
	broker.db
		.prepare(
			`INSERT INTO session
			 (session_id,collab_id,agent_type,registration_state,health_state,capabilities_json,registered_at,last_seen_at)
			 VALUES ('session_int_claude','collab_int','claude','registered','healthy','{}',?,?)`,
		)
		.run(now, now);
	broker.db
		.prepare(
			`INSERT INTO relay_turn_state
			 (collab_id,turn_owner,waiting_agent,unresolved_handoff_id,handoff_state,updated_at,
			  orchestrator_enabled,current_round,max_rounds,chain_status)
			 VALUES ('collab_int','codex','claude',NULL,'accepted',?,0,1,5,'active')`,
		)
		.run(now);
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

	it("enters Inspector (Enter) without throwing — exercises schema-validated reads (sessions, etc.)", async () => {
		// The Wall path queries the `session` table via raw SQL and never goes
		// through sessionSchema. The Inspector path calls control.listSessions
		// → mapRowToSession → sessionSchema.parse, which fails on malformed
		// IDs. Pressing Enter is what surfaces that class of bug in real use.
		const broker = newBroker();
		try {
			seedMinimal(broker);
			const stdout = new PassThrough();
			(stdout as unknown as { columns: number }).columns = 100;
			(stdout as unknown as { rows: number }).rows = 24;

			const m = createDashboardRuntime({
				broker,
				dashboardId: "dash_inspector",
				stdout: stdout as unknown as NodeJS.WritableStream,
				pollIntervalMs: 10,
			}) as never as {
				start(): void;
				stop(): Promise<void>;
				__handleKey(ev: { key?: string }): void;
				__mode(): string;
				__pollHealth(): { consecutiveErrors: number; lastError: string | null };
			};
			m.start();
			await new Promise((r) => setTimeout(r, 40)); // first poll populates lastPaneCollabIds
			expect(m.__mode()).toBe("wall");
			m.__handleKey({ key: "\r" }); // Enter → Inspector — triggers listSessions + schema parse
			await new Promise((r) => setTimeout(r, 30));
			expect(m.__mode()).toBe("inspector");
			// No poll errors, no thrown ZodError. The whole inspectorState()
			// pipeline ran against the real broker without falling over.
			const health = m.__pollHealth();
			expect(health.lastError).toBeNull();
			expect(health.consecutiveErrors).toBe(0);
			await m.stop();
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
