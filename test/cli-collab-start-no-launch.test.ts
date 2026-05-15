import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("cli collab start --no-launch", () => {
	it("reports active status after start", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-"));
		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-05T13:00:00.000Z",
			launchMode: "none",
		});
		const status = await runCollabStatus({ cwd: workspaceRoot });
		expect(status).toContain("status: active");
		expect(status).toContain("launch: none");
	});

	it("awaits waitForReady before resolving the start call", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-no-launch-ready-"),
		);
		let waitForReadyResolved = false;
		const waitForReady = vi.fn(async () => {
			await new Promise<void>((r) => setTimeout(r, 10));
			waitForReadyResolved = true;
			return true;
		});

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-05T13:00:00.000Z",
			launchMode: "none",
			waitForReady,
		});

		expect(waitForReady).toHaveBeenCalledTimes(1);
		expect(waitForReadyResolved).toBe(true);
	});

	it("defaults orchestratorEnabled to true when env var is unset", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-no-launch-orch-default-"),
		);
		const prior = process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;
		delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;

		try {
			const result = await startCollabForTest({
				workspaceRoot,
				now: "2026-04-29T00:00:00.000Z",
				launchMode: "none",
			});

			const broker = createBrokerRuntime({
				sqlitePath: getSharedSqlitePath(),
				host: "127.0.0.1",
				port: result.port,
				runWorkflowDriver: false,
				runDiagnosticsSweep: false,
				runDaemonHeartbeat: false,
				runBrokerDaemonSweep: false,
			});
			expect(broker.control.getCollab(result.collabId)).toEqual(
				expect.objectContaining({ orchestratorEnabled: true }),
			);
			await broker.stop();
		} finally {
			if (prior !== undefined) {
				process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED = prior;
			}
		}
	});

	it("disables orchestrator when env var is explicitly '0'", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-no-launch-orch-off-"),
		);
		const prior = process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED = "0";

		try {
			const result = await startCollabForTest({
				workspaceRoot,
				now: "2026-04-29T00:00:00.000Z",
				launchMode: "none",
			});

			const broker = createBrokerRuntime({
				sqlitePath: getSharedSqlitePath(),
				host: "127.0.0.1",
				port: result.port,
				runWorkflowDriver: false,
				runDiagnosticsSweep: false,
				runDaemonHeartbeat: false,
				runBrokerDaemonSweep: false,
			});
			expect(broker.control.getCollab(result.collabId)).toEqual(
				expect.objectContaining({ orchestratorEnabled: false }),
			);
			await broker.stop();
		} finally {
			if (prior !== undefined) {
				process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED = prior;
			} else {
				delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;
			}
		}
	});

	it("persists orchestrator config from environment when collab starts", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-orch-"));
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED = "1";
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS = "5";

		try {
			const result = await startCollabForTest({
				workspaceRoot,
				now: "2026-04-11T00:00:00.000Z",
				launchMode: "none",
			});

			const broker = createBrokerRuntime({
				sqlitePath: getSharedSqlitePath(),
				host: "127.0.0.1",
				port: result.port,
				runWorkflowDriver: false,
				runDiagnosticsSweep: false,
				runDaemonHeartbeat: false,
				runBrokerDaemonSweep: false,
			});
			expect(broker.control.getCollab(result.collabId)).toEqual(
				expect.objectContaining({
					orchestratorEnabled: true,
					orchestratorMaxRounds: 5,
				}),
			);
			await broker.stop();
		} finally {
			delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;
			delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS;
		}
	});
});
