import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertBrokerDaemon,
	updateBrokerDaemonPid,
	upsertWorkspace,
} from "../packages/broker/src/index.ts";
import { runCollabInspect } from "../packages/cli/src/commands/collab/inspect.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

function setupCollabWithVerdicts() {
	const root = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-vrd-"));
	process.env.AI_WHISPER_STATE_ROOT = root;
	const ws = join(root, "ws");
	mkdirSync(ws);
	const collabId = "collab_inspect_vrd";
	const now = "2026-05-14T12:00:00.000Z";

	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	const wsId = workspaceIdFromPath(ws);
	upsertWorkspace(broker.db, { id: wsId, workspaceRoot: ws, now });
	broker.db
		.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'vrd test', 'active', ?, 'none', NULL, ?, ?)",
		)
		.run(collabId, ws, wsId, now, now);
	insertBrokerDaemon(broker.db, {
		collabId,
		host: "127.0.0.1",
		port: 4605,
		startedAt: now,
		lastHeartbeatAt: now,
	});
	updateBrokerDaemonPid(broker.db, {
		collabId,
		pid: process.pid,
		pidStartTime: null,
		now,
	});

	for (let i = 0; i < 15; i += 1) {
		broker.control.recordEvaluatorDiagnostic({
			handoffId: `h_A_${i}`,
			collabId,
			chainId: "chain_A",
			workflowId: null, phaseRunId: null,
			evaluatorBranch: "legacy",
			evaluatorPromptKey: null, handoffStep: null,
			attemptKind: "primary",
			callGroupId: `cg_A_${i}`,
			provider: "anthropic",
			outcome: "ok",
			verdict: "done", confidence: 0.9, reason: "ok",
			followUpMessageLen: 0,
			latencyMs: 500,
			errorMessage: null,
			inputTokens: 400, outputTokens: 60,
			promptSample: "p", responseSample: "r",
			now: `2026-05-14T12:${String(i).padStart(2, "0")}:00.000Z`,
		});
	}
	for (let i = 0; i < 10; i += 1) {
		broker.control.recordEvaluatorDiagnostic({
			handoffId: `h_B_${i}`,
			collabId,
			chainId: "chain_B",
			workflowId: null, phaseRunId: null,
			evaluatorBranch: "review",
			evaluatorPromptKey: "review-loop", handoffStep: "review",
			attemptKind: "primary",
			callGroupId: `cg_B_${i}`,
			provider: "ollama",
			outcome: "ok",
			verdict: "approve", confidence: 0.7, reason: "approved",
			followUpMessageLen: 0,
			latencyMs: 2000,
			errorMessage: null,
			inputTokens: null, outputTokens: null,
			promptSample: "p", responseSample: "r",
			now: `2026-05-14T13:${String(i).padStart(2, "0")}:00.000Z`,
		});
	}

	return { ws, broker, collabId, now };
}

const healthyAssessBroker = () => Promise.resolve({ ok: true as const });

describe("whisper collab inspect --verdicts", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("verdicts=true shows the most recent 20 rows for the active collab", async () => {
		const { ws, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws, now, watch: false,
			verdicts: true,
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("OUTCOME");
		expect(output).toContain("h_B_9"); // newest
		expect(output).not.toContain("h_A_0"); // past the 20-row cap
	});

	it("verdicts=<chainId> filters to one chain", async () => {
		const { ws, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws, now, watch: false,
			verdicts: "chain_A",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("h_A_0");
		expect(output).not.toContain("h_B_0");
	});

	it("verdicts='all' shows every row for the active collab", async () => {
		const { ws, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws, now, watch: false,
			verdicts: "all",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("h_A_0");
		expect(output).toContain("h_B_9");
	});

	it("throws when both --verdicts and --captures are passed", async () => {
		const { ws, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		await expect(
			runCollabInspect({
				cwd: ws, now, watch: false,
				verdicts: true,
				captures: true,
				assessBroker: healthyAssessBroker,
			}),
		).rejects.toThrow(/mutually exclusive|cannot.*both|exclusive/i);
	});
});
