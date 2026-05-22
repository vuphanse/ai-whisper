import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	WORKFLOW_REVIEW_PROTOCOL,
	type ReviewMode,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("WORKFLOW_REVIEW_PROTOCOL canonical fragment", () => {
	it("names the three review modes", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toContain("chunk-review");
		expect(WORKFLOW_REVIEW_PROTOCOL).toContain("phase-review");
		expect(WORKFLOW_REVIEW_PROTOCOL).toContain("acceptance-review");
	});
	it("requires a printed acceptance matrix", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toMatch(/matrix/i);
	});
	it("requires test-fidelity review", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toMatch(/correct layer|exact condition/i);
	});
	it("defines the non-blocking risk channel", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toContain("Non-blocking risks");
	});
	it("routes missing context to escalate, not findings", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toMatch(/cannot proceed|blocked/i);
		expect(WORKFLOW_REVIEW_PROTOCOL).toMatch(/escalate/i);
	});
	it("requires an adversarial pass", () => {
		expect(WORKFLOW_REVIEW_PROTOCOL).toMatch(/adversarial/i);
	});
});
