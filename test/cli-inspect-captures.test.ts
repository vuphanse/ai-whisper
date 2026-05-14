import { describe, expect, it } from "vitest";
import { formatCapturesView } from "../packages/cli/src/runtime/operator-inspect-captures.ts";
import type { RelayCaptureDiagnosticRecord } from "@ai-whisper/broker";

function sampleRow(overrides: Partial<RelayCaptureDiagnosticRecord> = {}): RelayCaptureDiagnosticRecord {
	return {
		captureId: "capture_20260514T120000_h0001",
		handoffId: "handoff_0001",
		collabId: "collab_X",
		chainId: "chain_X1",
		workflowId: null,
		targetProvider: "claude",
		captureStatus: "ok",
		clipLen: 150,
		turnLen: 200,
		turnConfidence: "high",
		jaccardScore: 0.85,
		containmentScore: 0.95,
		clipSample: "the captured clipboard sample text",
		turnSample: "the captured pty turn sample",
		abortedByRaceGuard: false,
		createdAt: "2026-05-14T12:00:00.000Z",
		...overrides,
	};
}

describe("formatCapturesView", () => {
	it("renders empty state when no rows", () => {
		const out = formatCapturesView({ rows: [], collabId: "collab_X" });
		expect(out).toContain("No capture diagnostics for collab_X");
	});

	it("renders header + one row with all key fields", () => {
		const out = formatCapturesView({ rows: [sampleRow()], collabId: "collab_X" });
		expect(out).toContain("CAPTURE TIME");
		expect(out).toContain("STATUS");
		expect(out).toContain("PROV");
		expect(out).toContain("CLIP");
		expect(out).toContain("TURN");
		expect(out).toContain("JACCARD");
		expect(out).toContain("ok");
		expect(out).toContain("claude");
		expect(out).toContain("0.85");
		expect(out).toContain("handoff_0001");
	});

	it("marks aborted-by-race-guard rows with an indicator", () => {
		const out = formatCapturesView({
			rows: [sampleRow({ abortedByRaceGuard: true })],
			collabId: "collab_X",
		});
		expect(out).toMatch(/aborted|RACE/i);
	});

	it("truncates samples to 60 chars in the view", () => {
		const longSample = "x".repeat(200);
		const out = formatCapturesView({
			rows: [sampleRow({ clipSample: longSample, turnSample: longSample })],
			collabId: "collab_X",
		});
		expect(out).not.toMatch(/x{100,}/);
	});

	it("shows '-' for null scores", () => {
		const out = formatCapturesView({
			rows: [sampleRow({ jaccardScore: null, containmentScore: null })],
			collabId: "collab_X",
		});
		expect(out).toContain("-");
	});
});
