import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";

describe("broker runtime", () => {
	it("reports health and status from the minimal broker app", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-runtime-"));
		const runtime = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		const health = await runtime.app.inject({
			method: "GET",
			url: "/health",
		});

		const status = await runtime.app.inject({
			method: "GET",
			url: "/status",
		});

		expect(health.statusCode).toBe(200);
		expect(health.json()).toEqual({
			ok: true,
		});

		expect(status.statusCode).toBe(200);
		expect(status.json()).toMatchObject({
			version: 1,
			status: "healthy",
			storage: {
				driver: "sqlite",
				migrated: true,
			},
		});

		await runtime.stop();
	});

	it("createBrokerRuntime starts the diagnostics-sweep when runDiagnosticsSweep is true", async () => {
		vi.useFakeTimers();
		const prior = {
			interval: process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"],
			retention: process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"],
		};
		process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = "50";
		process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"] = "30";
		try {
			vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
			const dir = mkdtempSync(join(tmpdir(), "ai-whisper-broker-diag-"));
			const broker = createBrokerRuntime({
				sqlitePath: join(dir, "broker.sqlite"),
				host: "127.0.0.1",
				port: 4505,
				runWorkflowDriver: false, // isolate the diagnostics-sweep behavior
			});
			broker.control.recordCaptureDiagnostic({
				handoffId: "h_ancient", collabId: "x", chainId: null, workflowId: null,
				targetProvider: "claude", captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-01-01T00:00:00.000Z",
			});
			broker.control.recordCaptureDiagnostic({
				handoffId: "h_recent", collabId: "x", chainId: null, workflowId: null,
				targetProvider: "claude", captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-05-13T12:00:00.000Z",
			});

			vi.advanceTimersByTime(100);

			const remaining = broker.control.listCaptureDiagnosticsByCollab("x", 10);
			expect(remaining.map((r) => r.handoffId)).toEqual(["h_recent"]);

			await broker.stop();
		} finally {
			if (prior.interval === undefined) delete process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
			else process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = prior.interval;
			if (prior.retention === undefined) delete process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"];
			else process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"] = prior.retention;
			vi.useRealTimers();
		}
	});

	it("createBrokerRuntime does NOT start the diagnostics-sweep when runDiagnosticsSweep is false", async () => {
		vi.useFakeTimers();
		const prior = process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
		process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = "50";
		try {
			vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
			const dir = mkdtempSync(join(tmpdir(), "ai-whisper-broker-diag-off-"));
			const broker = createBrokerRuntime({
				sqlitePath: join(dir, "broker.sqlite"),
				host: "127.0.0.1",
				port: 4506,
				runWorkflowDriver: false,
				runDiagnosticsSweep: false,
			});
			broker.control.recordCaptureDiagnostic({
				handoffId: "h_ancient", collabId: "x", chainId: null, workflowId: null,
				targetProvider: "claude", captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-01-01T00:00:00.000Z",
			});

			vi.advanceTimersByTime(500);

			const remaining = broker.control.listCaptureDiagnosticsByCollab("x", 10);
			expect(remaining).toHaveLength(1);
			await broker.stop();
		} finally {
			if (prior === undefined) delete process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
			else process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = prior;
			vi.useRealTimers();
		}
	});
});
