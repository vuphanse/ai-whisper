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

function setupCollabWithCaptures() {
	const root = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-cap-"));
	process.env.AI_WHISPER_STATE_ROOT = root;
	const ws = join(root, "ws");
	mkdirSync(ws);
	const collabId = "collab_inspect_cap";
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
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at) VALUES (?, ?, 'inspect captures test', 'active', ?, 'none', NULL, ?, ?)",
		)
		.run(collabId, ws, wsId, now, now);
	insertBrokerDaemon(broker.db, {
		collabId,
		host: "127.0.0.1",
		port: 4506,
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
		broker.control.recordCaptureDiagnostic({
			handoffId: `handoff_A_${i}`,
			collabId,
			chainId: "chain_A",
			workflowId: null,
			targetProvider: "claude",
			captureStatus: "ok",
			clipLen: 150, turnLen: 200, turnConfidence: "high",
			jaccardScore: 0.8, containmentScore: 0.9,
			clipSample: "sample", turnSample: "sample",
			abortedByRaceGuard: false,
			now: `2026-05-14T12:${String(i).padStart(2, "0")}:00.000Z`,
		});
	}
	for (let i = 0; i < 10; i += 1) {
		broker.control.recordCaptureDiagnostic({
			handoffId: `handoff_B_${i}`,
			collabId,
			chainId: "chain_B",
			workflowId: null,
			targetProvider: "codex",
			captureStatus: "no_response_captured_confidently",
			clipLen: 5, turnLen: 12, turnConfidence: "low",
			jaccardScore: 0.1, containmentScore: 0.2,
			clipSample: "x", turnSample: "y",
			abortedByRaceGuard: false,
			now: `2026-05-14T13:${String(i).padStart(2, "0")}:00.000Z`,
		});
	}

	return { ws, broker, collabId, now };
}

const healthyAssessBroker = () => Promise.resolve({ ok: true as const });

describe("whisper collab inspect --captures", () => {
	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("captures=true shows the most recent 20 rows for the active collab", async () => {
		const { ws, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws,
			now,
			watch: false,
			captures: true,
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("STATUS");
		expect(output).toContain("handoff_B_9");
		expect(output).not.toContain("handoff_A_0");
	});

	it("captures=<chainId> filters to one chain", async () => {
		const { ws, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws,
			now,
			watch: false,
			captures: "chain_A",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("handoff_A_0");
		expect(output).not.toContain("handoff_B_0");
	});

	it("captures='all' shows every row for the active collab", async () => {
		const { ws, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			cwd: ws,
			now,
			watch: false,
			captures: "all",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("handoff_A_0");
		expect(output).toContain("handoff_B_9");
	});
});
