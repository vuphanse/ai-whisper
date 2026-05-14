import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runCollabInspect } from "../packages/cli/src/commands/collab/inspect.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";

function setupCollabWithVerdicts() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-inspect-vrd-"));
	const sqlitePath = join(dir, "broker.sqlite");
	const collabId = "collab_inspect_vrd";
	const now = "2026-05-14T12:00:00.000Z";

	const broker = createBrokerRuntime({
		sqlitePath, host: "127.0.0.1", port: 4605,
		runWorkflowDriver: false, runDiagnosticsSweep: false,
	});
	broker.control.startCollab({ collabId, workspaceRoot: dir, displayName: "vrd test", now });

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

	const statePath = join(dir, ".ai-whisper", "runtime", "current-collab.json");
	writeCliCollabState(statePath, {
		version: 5,
		collabId,
		workspaceRoot: dir,
		broker: { sqlitePath, host: "127.0.0.1", port: 4605, pid: 99002 },
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

describe("whisper collab inspect --verdicts", () => {
	it("verdicts=true shows the most recent 20 rows for the active collab", async () => {
		const { dir, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir, now, watch: false,
			verdicts: true,
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("OUTCOME");
		expect(output).toContain("h_B_9"); // newest
		expect(output).not.toContain("h_A_0"); // past the 20-row cap
	});

	it("verdicts=<chainId> filters to one chain", async () => {
		const { dir, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir, now, watch: false,
			verdicts: "chain_A",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("h_A_0");
		expect(output).not.toContain("h_B_0");
	});

	it("verdicts='all' shows every row for the active collab", async () => {
		const { dir, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		const output = await runCollabInspect({
			workspaceRoot: dir, now, watch: false,
			verdicts: "all",
			assessBroker: healthyAssessBroker,
		});
		expect(output).toContain("h_A_0");
		expect(output).toContain("h_B_9");
	});

	it("throws when both --verdicts and --captures are passed", async () => {
		const { dir, broker, now } = setupCollabWithVerdicts();
		await broker.stop();
		await expect(
			runCollabInspect({
				workspaceRoot: dir, now, watch: false,
				verdicts: true,
				captures: true,
				assessBroker: healthyAssessBroker,
			}),
		).rejects.toThrow(/mutually exclusive|cannot.*both|exclusive/i);
	});
});
