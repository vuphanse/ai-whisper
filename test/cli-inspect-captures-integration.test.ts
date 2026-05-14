import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runCollabInspect } from "../packages/cli/src/commands/collab/inspect.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";

function setupCollabWithCaptures() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-cap-"));
	const sqlitePath = join(dir, "broker.sqlite");
	const collabId = "collab_inspect_cap";
	const now = "2026-05-14T12:00:00.000Z";

	const broker = createBrokerRuntime({
		sqlitePath, host: "127.0.0.1", port: 4506,
		runWorkflowDriver: false, runDiagnosticsSweep: false,
	});
	broker.control.startCollab({
		collabId, workspaceRoot: dir, displayName: "inspect captures test", now,
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

	const statePath = join(dir, ".ai-whisper", "runtime", "current-collab.json");
	writeCliCollabState(statePath, {
		version: 5,
		collabId,
		workspaceRoot: dir,
		broker: { sqlitePath, host: "127.0.0.1", port: 4506, pid: 99001 },
		launch: { mode: "none" },
		ownedSessions: {},
		startedAt: now,
		recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
		adoptedSessions: {},
		mountedSessions: {},
	});

	return { dir, broker, collabId, now };
}

const healthyAssessBroker = () =>
	Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const });

describe("whisper collab inspect --captures", () => {
	it("captures=true shows the most recent 20 rows for the active collab", async () => {
		const { dir, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir,
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
		const { dir, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir,
			now,
			watch: false,
			captures: "chain_A",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("handoff_A_0");
		expect(output).not.toContain("handoff_B_0");
	});

	it("captures='all' shows every row for the active collab", async () => {
		const { dir, broker, now } = setupCollabWithCaptures();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir,
			now,
			watch: false,
			captures: "all",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("handoff_A_0");
		expect(output).toContain("handoff_B_9");
	});
});
