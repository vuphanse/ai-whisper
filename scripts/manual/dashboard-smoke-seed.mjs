#!/usr/bin/env node
/**
 * Seeds an isolated sqlite DB with mock fixtures for a manual smoke test of
 * the `collab dashboard` TUI.
 *
 * Run:
 *   node scripts/manual/dashboard-smoke-seed.mjs
 *   AI_WHISPER_STATE_ROOT=/tmp/aiw-dashboard-smoke node packages/cli/dist/bin/whisper.js collab dashboard
 *
 * Idempotent — re-running wipes the smoke directory and re-seeds.
 *
 * Three panes are seeded so every Wall + Inspector path renders:
 *   - c_alpha  : running workflow with a sibling done workflow + a manual
 *                handoff on the same collab. Exercises the multi-run leak
 *                fixes (handoff tail, summary lastActivityAt, diagnostics
 *                fallback) — Inspector for c_alpha must show ONLY wf_alpha_run
 *                rows in Live / Evidence / Cost.
 *   - c_beta   : manual-only collab (no workflow record). Resolves to the
 *                manual-relay summary; Inspector falls back to manualOnly
 *                diagnostics filter.
 *   - c_gamma  : workflow at 5/5 rounds, chain status=escalated, last handoff
 *                ~15min old. Pane border red, health line shows STUCK, Inspector
 *                Evidence shows the round-cap likelyCause heuristic.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../packages/broker/dist/storage/open-database.js";
import { applyMigrations } from "../../packages/broker/dist/storage/apply-migrations.js";

const stateRoot =
	process.env.AI_WHISPER_STATE_ROOT ?? "/tmp/aiw-dashboard-smoke";

rmSync(stateRoot, { recursive: true, force: true });
mkdirSync(stateRoot, { recursive: true });

const dbPath = join(stateRoot, "state.db");
const db = openDatabase(dbPath);
applyMigrations(db);

// ---------- timestamp helpers ----------
const nowMs = Date.now();
const tMinus = (sec) => new Date(nowMs - sec * 1000).toISOString();

// ---------- insert helpers ----------
function insCollab(id, workspaceRoot, displayName) {
	db.prepare(
		`INSERT INTO collab
		 (collab_id,workspace_root,display_name,status,created_at,updated_at,orchestrator_enabled,orchestrator_max_rounds)
		 VALUES (?,?,?, 'active', ?, ?, 0, 5)`,
	).run(id, workspaceRoot, displayName, tMinus(7200), tMinus(60));
}
function insWorkflow(w) {
	db.prepare(
		`INSERT INTO workflows
		 (workflow_id,collab_id,workflow_type,name,spec_path,role_bindings,status,
		  current_phase_index,halt_reason,workflow_context,created_at,updated_at)
		 VALUES (?,?,?,?, '/tmp/smoke-spec.md', '{}', ?, ?, NULL, '{}', ?, ?)`,
	).run(
		w.id,
		w.collab,
		w.type ?? "spec-driven-development",
		w.name ?? null,
		w.status ?? "running",
		w.phaseIdx ?? 1,
		w.createdAt,
		w.updatedAt ?? w.createdAt,
	);
}
function insPhase(p) {
	db.prepare(
		`INSERT INTO workflow_phases
		 (phase_run_id,workflow_id,phase_index,phase_name,chain_id,started_at,ended_at,outcome)
		 VALUES (?,?,?,?,?,?,?,?)`,
	).run(p.id, p.wf, p.idx, p.name, p.chain, p.started, p.ended ?? null, p.outcome ?? null);
}
function insChain(c) {
	db.prepare(
		`INSERT INTO relay_chains
		 (chain_id,collab_id,status,current_round,max_rounds,terminal_handoff_id,terminal_reason,created_at,updated_at)
		 VALUES (?,?,?,?,?, NULL, NULL, ?, ?)`,
	).run(c.id, c.collab, c.status ?? "active", c.round ?? 1, c.max ?? 5, tMinus(3600), tMinus(60));
}
function insHandoff(h) {
	db.prepare(
		`INSERT INTO relay_handoff
		 (handoff_id,collab_id,sender_agent,target_agent,request_text,status,created_at,
		  last_activity_at,capture_status,chain_id,round_number,handback_text,workflow_id,
		  phase_run_id,handoff_step,evaluator_verdict,evaluator_confidence,evaluator_reason)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		h.id,
		h.collab,
		h.sender ?? "codex",
		h.target ?? "claude",
		h.reqText ?? "smoke request",
		h.status ?? "handed_back",
		h.createdAt,
		h.lastAct ?? h.createdAt,
		h.capture ?? "ok",
		h.chain ?? null,
		h.round ?? null,
		h.handback ?? "smoke handback",
		h.wf ?? null,
		h.phase ?? null,
		h.step ?? null,
		h.verdict ?? null,
		h.conf ?? null,
		h.reason ?? null,
	);
}
function insTurnState(t) {
	db.prepare(
		`INSERT INTO relay_turn_state
		 (collab_id,turn_owner,waiting_agent,unresolved_handoff_id,handoff_state,updated_at,
		  orchestrator_enabled,current_round,max_rounds,chain_status)
		 VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, ?)`,
	).run(
		t.collab,
		t.owner ?? "codex",
		t.waiting ?? "claude",
		t.state ?? "accepted",
		tMinus(30),
		t.round ?? 1,
		t.max ?? 5,
		t.chainStatus ?? "active",
	);
}
function insSession(s) {
	db.prepare(
		`INSERT INTO session
		 (session_id,collab_id,agent_type,registration_state,health_state,
		  capabilities_json,registered_at,last_seen_at)
		 VALUES (?, ?, ?, 'registered', ?, '{}', ?, ?)`,
	).run(s.id, s.collab, s.agent, s.health ?? "healthy", tMinus(3600), tMinus(30));
}
function insEvalDiag(d) {
	db.prepare(
		`INSERT INTO relay_evaluator_diagnostics
		 (evaluator_id,handoff_id,collab_id,chain_id,workflow_id,phase_run_id,
		  evaluator_branch,evaluator_prompt_key,handoff_step,attempt_kind,call_group_id,
		  provider,outcome,verdict,confidence,reason,follow_up_message_len,latency_ms,
		  error_message,input_tokens,output_tokens,prompt_sample,response_sample,created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,'primary',?, 'anthropic','ok',?,?,?, 0, 800, NULL,
		         1200, 64, 'system prompt', 'sample response', ?)`,
	).run(
		d.id,
		d.handoff,
		d.collab,
		d.chain ?? null,
		d.wf ?? null,
		d.phase ?? null,
		d.branch ?? "review",
		"review-loop",
		d.step ?? "review",
		d.callGroup,
		d.verdict,
		d.conf,
		d.reason,
		d.at,
	);
}
function insCapDiag(d) {
	db.prepare(
		`INSERT INTO relay_capture_diagnostics
		 (capture_id,handoff_id,collab_id,chain_id,workflow_id,target_provider,
		  capture_status,clip_len,turn_len,turn_confidence,jaccard_score,containment_score,
		  clip_sample,turn_sample,aborted_by_race_guard,created_at)
		 VALUES (?,?,?,?,?, 'claude', ?, 200, 250, ?, 0.9, 0.95, NULL, NULL, 0, ?)`,
	).run(d.id, d.handoff, d.collab, d.chain ?? null, d.wf ?? null, d.status ?? "ok", d.conf ?? "high", d.at);
}

// =========================================================================
// PANE 1: c_alpha — running workflow + sibling done workflow + manual handoff
// (the multi-run-on-one-collab fixture; exercises every just-shipped fix)
// =========================================================================
insCollab("c_alpha", "/tmp/aiw-smoke-alpha", "alpha");
insWorkflow({
	id: "wf_alpha_done", collab: "c_alpha", status: "done",
	name: "old smoke (finished)", phaseIdx: 3, createdAt: tMinus(1800),
	updatedAt: tMinus(1000),
});
insWorkflow({
	id: "wf_alpha_run", collab: "c_alpha", status: "running",
	name: "smoke alpha", phaseIdx: 1, createdAt: tMinus(900),
	updatedAt: tMinus(120),
});
insChain({ id: "ch_alpha_done", collab: "c_alpha", status: "done", round: 3, max: 5 });
insChain({ id: "ch_alpha_run", collab: "c_alpha", status: "active", round: 2, max: 5 });
insPhase({
	id: "pr_alpha_done", wf: "wf_alpha_done", idx: 3, name: "plan-execution",
	chain: "ch_alpha_done", started: tMinus(1700), ended: tMinus(1000), outcome: "done",
});
insPhase({
	id: "pr_alpha_run", wf: "wf_alpha_run", idx: 1, name: "plan-writing",
	chain: "ch_alpha_run", started: tMinus(800), ended: null,
});
// Done workflow handoffs (would leak into a c_alpha pane if not workflow-scoped)
insHandoff({ id: "h_done_1", collab: "c_alpha", wf: "wf_alpha_done", phase: "pr_alpha_done", chain: "ch_alpha_done", createdAt: tMinus(1600), round: 1, step: "implement", verdict: "delivered", conf: 0.8, reason: "drafted" });
insHandoff({ id: "h_done_2", collab: "c_alpha", wf: "wf_alpha_done", phase: "pr_alpha_done", chain: "ch_alpha_done", createdAt: tMinus(1500), round: 2, step: "review", verdict: "approve", conf: 0.9, reason: "looks good" });
insHandoff({ id: "h_done_3", collab: "c_alpha", wf: "wf_alpha_done", phase: "pr_alpha_done", chain: "ch_alpha_done", createdAt: tMinus(1000), lastAct: tMinus(1000), round: 3, step: "execute", verdict: "delivered", conf: 0.95, reason: "shipped" });
// Manual relay handoff between runs (would also leak)
insHandoff({ id: "h_alpha_manual", collab: "c_alpha", wf: null, phase: null, chain: null, createdAt: tMinus(700), lastAct: tMinus(700), step: "manual chat", reason: "ad-hoc relay turn", handback: "ok" });
// Running workflow handoffs — these are what Inspector for c_alpha MUST display
insHandoff({ id: "h_run_1", collab: "c_alpha", wf: "wf_alpha_run", phase: "pr_alpha_run", chain: "ch_alpha_run", createdAt: tMinus(600), round: 1, step: "implement", verdict: "delivered", conf: 0.7, reason: "drafted plan section 1" });
insHandoff({
	id: "h_run_2", collab: "c_alpha", wf: "wf_alpha_run", phase: "pr_alpha_run",
	chain: "ch_alpha_run", createdAt: tMinus(120), lastAct: tMinus(120),
	round: 2, step: "review", sender: "claude", target: "codex",
	verdict: "findings", conf: 0.5, reason: "criterion 5 unmet — needs more detail",
});
insTurnState({ collab: "c_alpha", owner: "claude", waiting: "codex", state: "pending", round: 2, max: 5, chainStatus: "active" });
insSession({ id: "sess_alpha_codex", collab: "c_alpha", agent: "codex" });
insSession({ id: "sess_alpha_claude", collab: "c_alpha", agent: "claude" });
// Diagnostics for c_alpha's running run (Inspector Evidence section)
insEvalDiag({ id: "eval_alpha_run_2", handoff: "h_run_2", collab: "c_alpha", chain: "ch_alpha_run", wf: "wf_alpha_run", phase: "pr_alpha_run", callGroup: "cg_alpha_2", verdict: "findings", conf: 0.5, reason: "criterion 5 unmet", at: tMinus(120) });
insCapDiag({ id: "cap_alpha_run_2", handoff: "h_run_2", collab: "c_alpha", chain: "ch_alpha_run", wf: "wf_alpha_run", at: tMinus(120) });

// =========================================================================
// PANE 2: c_beta — manual-only collab (no workflow record)
// =========================================================================
insCollab("c_beta", "/tmp/aiw-smoke-beta", "beta");
insHandoff({ id: "h_man_b_1", collab: "c_beta", wf: null, phase: null, chain: null, createdAt: tMinus(400), step: "manual chat", reason: "first ping" });
insHandoff({ id: "h_man_b_2", collab: "c_beta", wf: null, phase: null, chain: null, createdAt: tMinus(60), lastAct: tMinus(60), step: "manual chat", reason: "reply", sender: "claude", target: "codex" });
insTurnState({ collab: "c_beta", owner: "codex", waiting: null, state: "idle", round: 0, max: 0, chainStatus: "done" });
insSession({ id: "sess_beta_codex", collab: "c_beta", agent: "codex" });

// =========================================================================
// PANE 3: c_gamma — stuck workflow at 5/5 rounds, chain escalated
// =========================================================================
insCollab("c_gamma", "/tmp/aiw-smoke-gamma", "gamma");
insWorkflow({
	id: "wf_gamma", collab: "c_gamma", status: "running",
	name: "stuck smoke", phaseIdx: 2, createdAt: tMinus(2400),
	updatedAt: tMinus(800),
});
insChain({ id: "ch_gamma", collab: "c_gamma", status: "escalated", round: 5, max: 5 });
insPhase({
	id: "pr_gamma", wf: "wf_gamma", idx: 2, name: "plan-writing",
	chain: "ch_gamma", started: tMinus(2300), ended: null,
});
insHandoff({ id: "h_g_1", collab: "c_gamma", wf: "wf_gamma", phase: "pr_gamma", chain: "ch_gamma", createdAt: tMinus(2000), round: 1, step: "implement", verdict: "delivered", conf: 0.6, reason: "drafted" });
insHandoff({ id: "h_g_2", collab: "c_gamma", wf: "wf_gamma", phase: "pr_gamma", chain: "ch_gamma", createdAt: tMinus(1700), round: 2, step: "review", sender: "claude", target: "codex", verdict: "findings", conf: 0.55, reason: "needs more" });
insHandoff({ id: "h_g_3", collab: "c_gamma", wf: "wf_gamma", phase: "pr_gamma", chain: "ch_gamma", createdAt: tMinus(1400), round: 3, step: "fix", verdict: "delivered", conf: 0.58, reason: "added partial" });
insHandoff({ id: "h_g_4", collab: "c_gamma", wf: "wf_gamma", phase: "pr_gamma", chain: "ch_gamma", createdAt: tMinus(1100), round: 4, step: "review", sender: "claude", target: "codex", verdict: "findings", conf: 0.49, reason: "criterion 5 still unmet" });
insHandoff({
	id: "h_g_5", collab: "c_gamma", wf: "wf_gamma", phase: "pr_gamma",
	chain: "ch_gamma", createdAt: tMinus(800), lastAct: tMinus(800),
	round: 5, step: "review", sender: "claude", target: "codex",
	verdict: "findings", conf: 0.43, reason: "criterion 5 still unmet — escalated at max",
});
insTurnState({ collab: "c_gamma", owner: "claude", waiting: "codex", state: "stale_handoff", round: 5, max: 5, chainStatus: "escalated" });
insSession({ id: "sess_gamma_codex", collab: "c_gamma", agent: "codex" });
insSession({ id: "sess_gamma_claude", collab: "c_gamma", agent: "claude" });
insEvalDiag({ id: "eval_gamma_5", handoff: "h_g_5", collab: "c_gamma", chain: "ch_gamma", wf: "wf_gamma", phase: "pr_gamma", callGroup: "cg_g_5", verdict: "findings", conf: 0.43, reason: "escalated at max", at: tMinus(800) });
insCapDiag({ id: "cap_gamma_3", handoff: "h_g_3", collab: "c_gamma", chain: "ch_gamma", wf: "wf_gamma", status: "truncated", conf: "low", at: tMinus(1400) });

db.close();

console.log("");
console.log(`✔ Seeded smoke fixture at  ${dbPath}`);
console.log("");
console.log("Three panes:");
console.log("  c_alpha  workflow running + sibling done workflow + manual handoff");
console.log("  c_beta   manual-only (no workflow record)");
console.log("  c_gamma  stuck workflow (escalated at 5/5)");
console.log("");
console.log("Launch the dashboard against this fixture:");
console.log("");
console.log(`  AI_WHISPER_STATE_ROOT=${stateRoot} node packages/cli/dist/bin/whisper.js collab dashboard`);
console.log("");
console.log("Cleanup when done:");
console.log("");
console.log(`  rm -rf ${stateRoot}`);
console.log("");
