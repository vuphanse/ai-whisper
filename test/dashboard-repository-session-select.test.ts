import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { listActiveCollabSummaries } from "../packages/broker/src/storage/repositories/dashboard-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-dash-sel-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function insCollab(db: ReturnType<typeof freshDb>, id: string, name = id) {
	db.prepare(
		`INSERT INTO collab (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
		 VALUES (?,?,?,'active','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z',0,3)`,
	).run(id, `/tmp/${id}`, name);
}

function insSession(
	db: ReturnType<typeof freshDb>,
	s: {
		id: string;
		collab: string;
		agent: "codex" | "claude";
		health?: "healthy" | "degraded" | "offline";
		registeredAt: string;
	},
) {
	db.prepare(
		`INSERT INTO session (session_id,collab_id,agent_type,registration_state,health_state,capabilities_json,registered_at,last_seen_at)
		 VALUES (?,?,?,'registered',?, '{}', ?, ?)`,
	).run(s.id, s.collab, s.agent, s.health ?? "healthy", s.registeredAt, s.registeredAt);
}

function insBinding(
	db: ReturnType<typeof freshDb>,
	b: { collab: string; agent: "codex" | "claude"; active: string },
) {
	db.prepare(
		`INSERT INTO session_binding (collab_id,agent_type,binding_state,active_session_id,binding_source,pending_claim_id,pending_claim_expires_at,updated_at)
		 VALUES (?,?,'bound',?, 'launched', NULL, NULL, '2026-05-20T00:00:00.000Z')`,
	).run(b.collab, b.agent, b.active);
}

// A handoff is needed for the collab to be "eligible" (recency window) when no
// running workflow exists.
function insHandoff(db: ReturnType<typeof freshDb>, h: { id: string; collab: string; lastAct: string }) {
	db.prepare(
		`INSERT INTO relay_handoff (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,last_activity_at)
		 VALUES (?,?,'codex','claude','req','handed_back',?,?)`,
	).run(h.id, h.collab, h.lastAct, h.lastAct);
}

const NOW = "2026-05-20T01:00:00.000Z";
const sinceMs = 30 * 60_000;

describe("dashboard agent-session selection (Bug A)", () => {
	it("(a) bound selection: returns the bound (new, healthy) row over an old degraded row", () => {
		const db = freshDb();
		insCollab(db, "c1");
		insHandoff(db, { id: "h1", collab: "c1", lastAct: "2026-05-20T00:59:00.000Z" });
		// OLD degraded row + NEW healthy row for the same agent.
		insSession(db, { id: "old", collab: "c1", agent: "codex", health: "degraded", registeredAt: "2026-05-20T00:10:00.000Z" });
		insSession(db, { id: "new", collab: "c1", agent: "codex", health: "healthy", registeredAt: "2026-05-20T00:50:00.000Z" });
		insBinding(db, { collab: "c1", agent: "codex", active: "new" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const codex = rows[0]!.sessions.filter((s) => s.agentType === "codex");
		expect(codex).toHaveLength(1);
		expect(codex[0]!.healthState).toBe("healthy");
	});

	it("(b) degraded preserved: a bound degraded session keeps its degraded health (not coerced)", () => {
		const db = freshDb();
		insCollab(db, "c2");
		insHandoff(db, { id: "h2", collab: "c2", lastAct: "2026-05-20T00:59:00.000Z" });
		insSession(db, { id: "old", collab: "c2", agent: "claude", health: "healthy", registeredAt: "2026-05-20T00:10:00.000Z" });
		insSession(db, { id: "cur", collab: "c2", agent: "claude", health: "degraded", registeredAt: "2026-05-20T00:50:00.000Z" });
		insBinding(db, { collab: "c2", agent: "claude", active: "cur" });

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const claude = rows[0]!.sessions.filter((s) => s.agentType === "claude");
		expect(claude).toHaveLength(1);
		expect(claude[0]!.healthState).toBe("degraded");
	});

	it("(c) no-binding fallback: returns the greatest registered_at row", () => {
		const db = freshDb();
		insCollab(db, "c3");
		insHandoff(db, { id: "h3", collab: "c3", lastAct: "2026-05-20T00:59:00.000Z" });
		insSession(db, { id: "older", collab: "c3", agent: "codex", health: "degraded", registeredAt: "2026-05-20T00:10:00.000Z" });
		insSession(db, { id: "newer", collab: "c3", agent: "codex", health: "healthy", registeredAt: "2026-05-20T00:50:00.000Z" });
		// no session_binding row

		const rows = listActiveCollabSummaries(db, { sinceMs, now: NOW });
		const codex = rows[0]!.sessions.filter((s) => s.agentType === "codex");
		expect(codex).toHaveLength(1);
		expect(codex[0]!.healthState).toBe("healthy");
	});
});
