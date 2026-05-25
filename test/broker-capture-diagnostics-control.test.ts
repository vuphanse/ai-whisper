import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-cap-diag-ctrl-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4503 });
}

describe("broker.control capture diagnostics", () => {
	it("recordCaptureDiagnostic writes a row and listCaptureDiagnosticsByCollab returns it", () => {
		const broker = newBroker();
		try {
			broker.control.recordCaptureDiagnostic({
				handoffId: "handoff_1",
				collabId: "collab_a",
				chainId: "chain_1",
				workflowId: null,
				targetProvider: "claude",
				captureStatus: "ok",
				clipLen: 120,
				turnLen: 130,
				turnConfidence: "high",
				jaccardScore: 0.7,
				containmentScore: 0.9,
				clipSample: "clip sample",
				turnSample: "turn sample",
				abortedByRaceGuard: false,
				now: "2026-05-14T10:00:00.000Z",
			});

			const rows = broker.control.listCaptureDiagnosticsByCollab("collab_a", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.captureStatus).toBe("ok");
			expect(rows[0]?.captureId.startsWith("capture_")).toBe(true);
		} finally {
			void broker.stop();
		}
	});

	it("persists interferenceDetected=true and reads it back", () => {
		const broker = newBroker();
		try {
			broker.control.recordCaptureDiagnostic({
				handoffId: "handoff_x",
				collabId: "collab_x",
				chainId: null,
				workflowId: null,
				targetProvider: "claude",
				captureStatus: "no_response_captured_confidently",
				clipLen: 0,
				turnLen: 42,
				turnConfidence: "high",
				jaccardScore: null,
				containmentScore: null,
				clipSample: null,
				turnSample: null,
				abortedByRaceGuard: false,
				interferenceDetected: true,
				now: "2026-05-25T00:00:00.000Z",
			});
			const rows = broker.control.listCaptureDiagnosticsByCollab("collab_x", null);
			expect(rows[0]?.interferenceDetected).toBe(true);
		} finally {
			void broker.stop();
		}
	});

	it("defaults interferenceDetected to false when omitted", () => {
		const broker = newBroker();
		try {
			broker.control.recordCaptureDiagnostic({
				handoffId: "handoff_y",
				collabId: "collab_y",
				chainId: null,
				workflowId: null,
				targetProvider: "codex",
				captureStatus: "ok",
				clipLen: 150,
				turnLen: 0,
				turnConfidence: "low",
				jaccardScore: null,
				containmentScore: null,
				clipSample: null,
				turnSample: null,
				abortedByRaceGuard: false,
				now: "2026-05-25T00:00:01.000Z",
			});
			const rows = broker.control.listCaptureDiagnosticsByCollab("collab_y", null);
			expect(rows[0]?.interferenceDetected).toBe(false);
		} finally {
			void broker.stop();
		}
	});

	it("sweepCaptureDiagnostics returns the deleted-row count", () => {
		const broker = newBroker();
		try {
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

			const deleted = broker.control.sweepCaptureDiagnostics({
				cutoffIso: "2026-05-01T00:00:00.000Z",
			});
			expect(deleted).toBe(1);

			const rows = broker.control.listCaptureDiagnosticsByCollab("x", 10);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.handoffId).toBe("h_new");
		} finally {
			void broker.stop();
		}
	});
});
