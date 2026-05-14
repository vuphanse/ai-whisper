import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createDiagnosticsSweep } from "../packages/broker/src/runtime/diagnostics-sweep.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-diag-sweep-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4504 });
}

describe("diagnostics-sweep", () => {
	it("deletes rows older than retentionDays on each tick", () => {
		vi.useFakeTimers();
		const broker = newBroker();
		try {
			const now = new Date("2026-05-14T00:00:00.000Z");
			vi.setSystemTime(now);

			broker.control.recordCaptureDiagnostic({
				handoffId: "h_old", collabId: "x", chainId: null, workflowId: null,
				targetProvider: "claude", captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-04-01T00:00:00.000Z",
			});
			broker.control.recordCaptureDiagnostic({
				handoffId: "h_new", collabId: "x", chainId: null, workflowId: null,
				targetProvider: "claude", captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-05-13T00:00:00.000Z",
			});

			const sweep = createDiagnosticsSweep({
				broker: { control: broker.control },
				intervalMs: 100,
				retentionDays: 30,
			});
			sweep.start();
			vi.advanceTimersByTime(150);
			sweep.stop();

			const rows = broker.control.listCaptureDiagnosticsByCollab("x", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.handoffId).toBe("h_new");
		} finally {
			void broker.stop();
			vi.useRealTimers();
		}
	});

	it("stop() cancels pending ticks cleanly", () => {
		vi.useFakeTimers();
		const broker = newBroker();
		try {
			vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
			const sweepSpy = vi.spyOn(broker.control, "sweepCaptureDiagnostics");

			const sweep = createDiagnosticsSweep({
				broker: { control: broker.control },
				intervalMs: 100,
				retentionDays: 30,
			});
			sweep.start();
			sweep.stop();
			vi.advanceTimersByTime(500);

			expect(sweepSpy).not.toHaveBeenCalled();
		} finally {
			void broker.stop();
			vi.useRealTimers();
		}
	});

	it("uses env-overrides when present", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
		const prior = {
			interval: process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"],
			retention: process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"],
		};
		process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = "50";
		process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"] = "7";

		const broker = newBroker();
		try {
			const sweepSpy = vi.spyOn(broker.control, "sweepCaptureDiagnostics");
			const sweep = createDiagnosticsSweep({ broker: { control: broker.control } });
			sweep.start();
			vi.advanceTimersByTime(60);
			sweep.stop();

			expect(sweepSpy).toHaveBeenCalled();
			const cutoffArg = sweepSpy.mock.calls[0]?.[0]?.cutoffIso ?? "";
			// 7 days before 2026-05-14 = 2026-05-07
			expect(cutoffArg.startsWith("2026-05-07")).toBe(true);
		} finally {
			void broker.stop();
			if (prior.interval === undefined) delete process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
			else process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"] = prior.interval;
			if (prior.retention === undefined) delete process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"];
			else process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"] = prior.retention;
			vi.useRealTimers();
		}
	});
});
