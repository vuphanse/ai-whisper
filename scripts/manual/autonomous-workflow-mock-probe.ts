#!/usr/bin/env node
// Autonomous-workflow probe (mock orchestrator + mock implementer).
// Embeds @ai-whisper/broker, drives each scenario via broker.control, asserts
// terminal state. No real LLM cost. No mount panes. No HTTP listener.

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createBrokerRuntime } from "../../packages/broker/src/index.ts";
import { createRelayOrchestrator } from "../../packages/cli/src/runtime/relay-orchestrator.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

const ALL_SCENARIOS = ["happy", "findings", "escalate", "resume", "cancel"];

function parseArgs(argv) {
	const out = { scenario: "happy", logDir: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--scenario") out.scenario = argv[++i];
		else if (a === "--log-dir") out.logDir = argv[++i];
		else if (a === "--help" || a === "-h") {
			process.stdout.write(
				`Usage: autonomous-workflow-mock-probe.mjs --scenario <happy|findings|escalate|resume|cancel|all> [--log-dir <path>]\n`,
			);
			process.exit(0);
		} else {
			process.stderr.write(`Unknown arg: ${a}\n`);
			process.exit(2);
		}
	}
	return out;
}

function initRepo() {
	const dir = mkdtempSync(join(tmpdir(), "whisper-probe-"));
	execSync("git init --quiet", { cwd: dir });
	execSync(
		"git -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet",
		{ cwd: dir },
	);
	writeFileSync(
		join(dir, "spec.md"),
		"# probe spec\n\nTiny canned spec for mock smoke.\n",
	);
	execSync(
		`git -c user.email=t@t -c user.name=t -C "${dir}" add . && git -c user.email=t@t -c user.name=t -C "${dir}" commit -m spec --quiet`,
	);
	return dir;
}

function gitHead(repo) {
	return execSync(`git -C "${repo}" rev-parse HEAD`).toString().trim();
}

function makeRealCommit(repo, label) {
	writeFileSync(join(repo, `${label}.txt`), `content for ${label}\n`);
	execSync(
		`git -c user.email=t@t -c user.name=t -C "${repo}" add . && git -c user.email=t@t -c user.name=t -C "${repo}" commit -m ${label} --quiet`,
	);
	return gitHead(repo);
}

function findPendingWorkflowHandoff(broker, workflowId) {
	return broker.db
		.prepare(
			`SELECT handoff_id, sender_agent, target_agent, handoff_step
			 FROM relay_handoff
			 WHERE workflow_id = ? AND status = 'pending'
			 ORDER BY created_at ASC
			 LIMIT 1`,
		)
		.get(workflowId);
}

async function yieldToDriver() {
	// WorkflowDriver schedules kickoffCurrentPhase via setImmediate after
	// workflow.created / workflow.resumed / chain advance. Yield twice to be
	// safe against micro-task ordering.
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

function makeBroker(port) {
	return createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port,
	});
}

function seedCollab(broker, collabId, repo, maxRounds) {
	const now = new Date().toISOString();
	broker.control.startCollab({
		collabId,
		workspaceRoot: repo,
		displayName: collabId,
		orchestratorEnabled: true,
		orchestratorMaxRounds: maxRounds,
		now,
	});
	for (const agent of ["claude", "codex"]) {
		broker.control.setSessionBinding({
			collabId,
			agentType: agent,
			sessionId: `session_${agent}_${collabId}`,
			bindingSource: "adopted",
			now,
		});
	}
}

function mkOrchestrator(broker, collabId, repo, verdictQueue) {
	return createRelayOrchestrator({
		broker,
		collabId,
		evaluate: async () => {
			if (verdictQueue.length === 0) {
				throw new Error("verdict queue exhausted — scenario script too short");
			}
			return verdictQueue.shift();
		},
		readWorkspaceHead: async () => gitHead(repo),
		pollIntervalMs: 10,
	});
}

async function driveOneRound(broker, workflowId, orchestrator, repo, i) {
	const row = findPendingWorkflowHandoff(broker, workflowId);
	if (!row) {
		throw new Error(`step ${i}: no pending handoff for workflow ${workflowId}`);
	}
	const now = new Date().toISOString();
	broker.control.acceptRelayHandoff({
		handoffId: row.handoff_id,
		acceptedAt: now,
	});

	let handback;
	if (row.handoff_step === "execute") {
		const sha = makeRealCommit(repo, `exec-${i}`);
		handback = `Implemented. Latest commit: ${sha}`;
	} else {
		handback = `mock handback step=${row.handoff_step} i=${i}`;
	}

	broker.control.handoffBackRelay({
		handoffId: row.handoff_id,
		senderAgent: row.target_agent,
		targetAgent: row.sender_agent,
		requestText: handback,
		now,
	});

	await orchestrator.pollOnce();
	await yieldToDriver();
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Mock-verdict builders. Each scenario pushes verdicts into the shared queue
// in the order the orchestrator will consume them (one per handed-back
// handoff).
function verdict(v, extra = {}) {
	return { verdict: v, confidence: 0.9, reason: "mock", ...extra };
}

async function scenarioHappy({ broker, workflowId, orchestrator, repo }) {
	const wfId = workflowId;
	// 4 phases: spec-review-approve, plan-implement-delivered,
	// plan-review-approve, execute-pass, code-review-approve → 5 rounds.
	const queue = [
		verdict("approve"),
		verdict("delivered"),
		verdict("approve"),
		verdict("execution-pass"),
		verdict("approve"),
	];
	orchestrator.__queue.push(...queue);
	for (let i = 0; i < queue.length; i++) {
		await driveOneRound(broker, wfId, orchestrator, repo, i);
	}
	const wf = broker.control.getWorkflow(wfId);
	assertEq(wf?.status, "done", "workflow.status");
	const ctx = wf.workflowContext ?? {};
	assert(ctx.commitRange, "commitRange populated");
	assert(
		ctx.commitRange === `${ctx.baseBeforeExecution}..${ctx.headAfterExecution}`,
		"commitRange equals base..head",
	);
	assert(ctx.baseBeforeExecution !== ctx.headAfterExecution, "base !== head");
}

async function scenarioFindings({ broker, workflowId, orchestrator, repo }) {
	// spec-refining: findings → fix+delivered → approve. Then normal path.
	const queue = [
		verdict("findings", { followUpMessage: "please fix spec issues" }),
		verdict("delivered"),
		verdict("approve"),
		verdict("delivered"),
		verdict("approve"),
		verdict("execution-pass"),
		verdict("approve"),
	];
	orchestrator.__queue.push(...queue);
	for (let i = 0; i < queue.length; i++) {
		await driveOneRound(broker, workflowId, orchestrator, repo, i);
	}
	const wf = broker.control.getWorkflow(workflowId);
	assertEq(wf?.status, "done", "workflow.status");

	// Assert there was at least one fix step recorded for spec-refining.
	const handoffs = broker.db
		.prepare(
			`SELECT handoff_step FROM relay_handoff
			 WHERE workflow_id=? ORDER BY created_at ASC`,
		)
		.all(workflowId);
	const steps = handoffs.map((h) => h.handoff_step);
	assert(steps.includes("fix"), "fix-step handoff recorded");
}

async function scenarioEscalate({ broker, workflowId, orchestrator, repo }) {
	// maxRounds=5 for spec-refining. Drive 5 findings with interleaved deliveries.
	// On 5th findings, currentRound=5; next review would be round 6 > 5 →
	// broker forces escalate, halts workflow.
	const queue = [
		verdict("findings", { followUpMessage: "r1" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r2" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r3" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r4" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r5" }),
	];
	orchestrator.__queue.push(...queue);
	for (let i = 0; i < queue.length; i++) {
		await driveOneRound(broker, workflowId, orchestrator, repo, i);
	}
	const wf = broker.control.getWorkflow(workflowId);
	assertEq(wf?.status, "halted", "workflow.status halted");
	assert(
		typeof wf.haltReason === "string" && wf.haltReason.length > 0,
		"haltReason populated",
	);
	assert(
		wf.haltReason.includes("max-rounds-reached"),
		`haltReason mentions max-rounds-reached (got ${JSON.stringify(wf.haltReason)})`,
	);
}

async function scenarioResume({ broker, workflowId, orchestrator, repo }) {
	// Halt via escalate, then resume, then drive happy path to done.
	const halt = [
		verdict("findings", { followUpMessage: "r1" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r2" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r3" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r4" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r5" }),
	];
	orchestrator.__queue.push(...halt);
	for (let i = 0; i < halt.length; i++) {
		await driveOneRound(broker, workflowId, orchestrator, repo, i);
	}
	assertEq(
		broker.control.getWorkflow(workflowId)?.status,
		"halted",
		"pre-resume halted",
	);

	broker.control.resumeWorkflow({
		workflowId,
		now: new Date().toISOString(),
	});
	await yieldToDriver();

	const rest = [
		verdict("approve"),
		verdict("delivered"),
		verdict("approve"),
		verdict("execution-pass"),
		verdict("approve"),
	];
	orchestrator.__queue.push(...rest);
	for (let i = 0; i < rest.length; i++) {
		await driveOneRound(broker, workflowId, orchestrator, repo, halt.length + i);
	}

	const wf = broker.control.getWorkflow(workflowId);
	assertEq(wf?.status, "done", "post-resume done");

	const runs = broker.control.getWorkflowPhaseRuns(workflowId);
	const specRuns = runs.filter((r) => r.phaseIndex === 0);
	assert(
		specRuns.length >= 2,
		`spec-refining has >=2 phase-run rows (got ${specRuns.length})`,
	);
	const escalated = specRuns.find((r) => r.outcome === "escalated");
	const done = specRuns.find((r) => r.outcome === "done");
	assert(escalated, "prior spec-refining run preserved with outcome=escalated");
	assert(done, "fresh spec-refining run closed with outcome=done");
}

async function scenarioCancel({ broker, workflowId, orchestrator, repo }) {
	// Halt → cancel → resume must reject.
	const halt = [
		verdict("findings", { followUpMessage: "r1" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r2" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r3" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r4" }),
		verdict("delivered"),
		verdict("findings", { followUpMessage: "r5" }),
	];
	orchestrator.__queue.push(...halt);
	for (let i = 0; i < halt.length; i++) {
		await driveOneRound(broker, workflowId, orchestrator, repo, i);
	}
	assertEq(
		broker.control.getWorkflow(workflowId)?.status,
		"halted",
		"pre-cancel halted",
	);

	broker.control.cancelWorkflow({
		workflowId,
		now: new Date().toISOString(),
	});
	assertEq(
		broker.control.getWorkflow(workflowId)?.status,
		"canceled",
		"status=canceled",
	);

	let rejected = false;
	try {
		broker.control.resumeWorkflow({
			workflowId,
			now: new Date().toISOString(),
		});
	} catch (err) {
		rejected = true;
		assert(
			/canceled/.test(err.message),
			`resume error mentions canceled (got ${err.message})`,
		);
	}
	assert(rejected, "resume on canceled workflow threw");
}

const SCENARIO_IMPL = {
	happy: { fn: scenarioHappy, maxRounds: 3 },
	findings: { fn: scenarioFindings, maxRounds: 5 },
	escalate: { fn: scenarioEscalate, maxRounds: 5 },
	resume: { fn: scenarioResume, maxRounds: 5 },
	cancel: { fn: scenarioCancel, maxRounds: 5 },
};

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assert(cond, msg) {
	if (!cond) throw new Error(`ASSERT: ${msg}`);
}
function assertEq(actual, expected, msg) {
	if (actual !== expected)
		throw new Error(
			`ASSERT: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

let portCursor = 14311;

async function runOne(name) {
	const impl = SCENARIO_IMPL[name];
	if (!impl) throw new Error(`Unknown scenario: ${name}`);
	const repo = initRepo();
	const port = portCursor++;
	const broker = makeBroker(port);

	// Never call broker.start() — we don't need HTTP.
	const collabId = `collab_${name}`;
	seedCollab(broker, collabId, repo, impl.maxRounds);

	// The orchestrator's evaluate fn reads from a shared queue that scenarios
	// append to. Attach a __queue property so the scenario can push verdicts.
	const queue = [];
	const orchestrator = mkOrchestrator(broker, collabId, repo, queue);
	orchestrator.__queue = queue;

	const { workflowId } = broker.control.createWorkflow({
		collabId,
		workflowType: "superpowers-feature-development",
		specPath: "spec.md",
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now: new Date().toISOString(),
	});
	await yieldToDriver();

	try {
		await impl.fn({ broker, workflowId, orchestrator, repo });
		return { scenario: name, ok: true, reason: null };
	} catch (err) {
		return {
			scenario: name,
			ok: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await broker.stop();
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { scenario, logDir } = parseArgs(process.argv.slice(2));
	const targets =
		scenario === "all"
			? ALL_SCENARIOS
			: ALL_SCENARIOS.includes(scenario)
				? [scenario]
				: null;
	if (!targets) {
		process.stderr.write(
			`unknown scenario: ${scenario} (expected: ${ALL_SCENARIOS.join("|")}|all)\n`,
		);
		process.exit(2);
	}

	const results = [];
	for (const name of targets) {
		const r = await runOne(name);
		const label = r.ok ? "PASS" : "FAIL";
		process.stdout.write(
			`${label}  scenario=${r.scenario}${r.ok ? "" : ` reason=${r.reason}`}\n`,
		);
		results.push(r);
	}

	const ok = results.every((r) => r.ok);
	const summary =
		[
			`Autonomous workflow mock-orchestrator probe summary`,
			`repo_root: ${REPO_ROOT}`,
			`scenarios: ${targets.join(",")}`,
			...results.map(
				(r) =>
					`  ${r.ok ? "PASS" : "FAIL"}  ${r.scenario}${r.ok ? "" : ` — ${r.reason}`}`,
			),
			`Probe verdict: ${ok ? "PASS" : "FAIL"}`,
			"",
		].join("\n");

	if (logDir) {
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, "probe-summary.txt"), summary);
	}
	process.stdout.write(summary);
	process.exit(ok ? 0 : 1);
}

await main();
