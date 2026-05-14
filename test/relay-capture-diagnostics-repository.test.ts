import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertCaptureDiagnostic,
	listCaptureDiagnosticsByCollab,
	listCaptureDiagnosticsByChain,
	listCaptureDiagnosticsByHandoff,
	deleteCaptureDiagnosticsOlderThan,
} from "../packages/broker/src/storage/repositories/relay-capture-diagnostics-repository.ts";

function newBroker() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-cap-diag-repo-"));
	return createBrokerRuntime({ sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4502 });
}

describe("relay-capture-diagnostics repository", () => {
	it("round-trips a row through insert + listByCollab", () => {
		const broker = newBroker();
		try {
			insertCaptureDiagnostic(broker.db, {
				captureId: "capture_001",
				handoffId: "handoff_001",
				collabId: "collab_a",
				chainId: "chain_001",
				workflowId: null,
				targetProvider: "claude",
				captureStatus: "ok",
				clipLen: 150,
				turnLen: 200,
				turnConfidence: "high",
				jaccardScore: 0.8,
				containmentScore: 0.9,
				clipSample: "sample clip",
				turnSample: "sample turn",
				abortedByRaceGuard: false,
				createdAt: "2026-05-14T10:00:00.000Z",
			});

			const rows = listCaptureDiagnosticsByCollab(broker.db, "collab_a", 20);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				captureId: "capture_001",
				handoffId: "handoff_001",
				captureStatus: "ok",
				abortedByRaceGuard: false,
				jaccardScore: 0.8,
			});
		} finally {
			void broker.stop();
		}
	});

	it("listByCollab returns rows ordered by created_at DESC, limited", () => {
		const broker = newBroker();
		try {
			for (let i = 0; i < 5; i += 1) {
				insertCaptureDiagnostic(broker.db, {
					captureId: `capture_${i}`,
					handoffId: `handoff_${i}`,
					collabId: "collab_b",
					chainId: null,
					workflowId: null,
					targetProvider: "codex",
					captureStatus: "no_response_captured",
					clipLen: 0,
					turnLen: 0,
					turnConfidence: "low",
					jaccardScore: null,
					containmentScore: null,
					clipSample: null,
					turnSample: null,
					abortedByRaceGuard: false,
					createdAt: `2026-05-14T10:0${i}:00.000Z`,
				});
			}
			const rows = listCaptureDiagnosticsByCollab(broker.db, "collab_b", 3);
			expect(rows.map((r) => r.captureId)).toEqual(["capture_4", "capture_3", "capture_2"]);
		} finally {
			void broker.stop();
		}
	});

	it("listByChain filters by chain_id", () => {
		const broker = newBroker();
		try {
			insertCaptureDiagnostic(broker.db, {
				captureId: "capture_c1", handoffId: "h_c1", collabId: "x", chainId: "chain_X",
				workflowId: null, targetProvider: "claude", captureStatus: "ok",
				clipLen: 100, turnLen: 100, turnConfidence: "high",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false, createdAt: "2026-05-14T10:00:00.000Z",
			});
			insertCaptureDiagnostic(broker.db, {
				captureId: "capture_c2", handoffId: "h_c2", collabId: "x", chainId: "chain_Y",
				workflowId: null, targetProvider: "claude", captureStatus: "ok",
				clipLen: 100, turnLen: 100, turnConfidence: "high",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false, createdAt: "2026-05-14T10:01:00.000Z",
			});
			const rows = listCaptureDiagnosticsByChain(broker.db, "chain_X", 20);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.captureId).toBe("capture_c1");
		} finally {
			void broker.stop();
		}
	});

	it("listByHandoff returns all rows (including aborted) for one handoff", () => {
		const broker = newBroker();
		try {
			for (let i = 0; i < 2; i += 1) {
				insertCaptureDiagnostic(broker.db, {
					captureId: `capture_h${i}`, handoffId: "h_shared", collabId: "x",
					chainId: null, workflowId: null, targetProvider: "claude",
					captureStatus: "no_response_captured_confidently",
					clipLen: 10, turnLen: 50, turnConfidence: "low",
					jaccardScore: 0.2, containmentScore: 0.3,
					clipSample: null, turnSample: null,
					abortedByRaceGuard: i === 1,
					createdAt: `2026-05-14T10:0${i}:00.000Z`,
				});
			}
			const rows = listCaptureDiagnosticsByHandoff(broker.db, "h_shared");
			expect(rows).toHaveLength(2);
			expect(rows.some((r) => r.abortedByRaceGuard)).toBe(true);
		} finally {
			void broker.stop();
		}
	});

	it("deleteOlderThan removes rows strictly older than the cutoff", () => {
		const broker = newBroker();
		try {
			insertCaptureDiagnostic(broker.db, {
				captureId: "old", handoffId: "h_old", collabId: "x",
				chainId: null, workflowId: null, targetProvider: "claude",
				captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				createdAt: "2026-04-01T00:00:00.000Z",
			});
			insertCaptureDiagnostic(broker.db, {
				captureId: "new", handoffId: "h_new", collabId: "x",
				chainId: null, workflowId: null, targetProvider: "claude",
				captureStatus: "ok",
				clipLen: 0, turnLen: 0, turnConfidence: "low",
				jaccardScore: null, containmentScore: null,
				clipSample: null, turnSample: null,
				abortedByRaceGuard: false,
				createdAt: "2026-05-13T00:00:00.000Z",
			});

			const deleted = deleteCaptureDiagnosticsOlderThan(broker.db, "2026-05-01T00:00:00.000Z");
			expect(deleted).toBe(1);

			const remaining = listCaptureDiagnosticsByCollab(broker.db, "x", 10);
			expect(remaining.map((r) => r.captureId)).toEqual(["new"]);
		} finally {
			void broker.stop();
		}
	});
});
