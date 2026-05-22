import { describe, expect, it } from "vitest";
// Direct module-path import (matches existing registry tests; these symbols are
// NOT on the broker package index).
import {
	WORKFLOW_REVIEW_PROTOCOL,
	type ReviewMode,
	renderTemplate,
	SPEC_DRIVEN_DEVELOPMENT,
	RALPH_LOOP,
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

const MARKER = "ai-whisper workflow review protocol";

describe("review templates embed the protocol", () => {
	it("every SDD review step embeds the fragment", () => {
		for (const phase of SPEC_DRIVEN_DEVELOPMENT.phases) {
			const review = phase.stepTemplates.review;
			if (!review) continue;
			expect(review).toContain(MARKER);
		}
	});
	it("review-as-kickoff phases embed the fragment in kickoffTemplate too", () => {
		for (const phase of SPEC_DRIVEN_DEVELOPMENT.phases) {
			if (phase.initialHandoffStep === "review") {
				expect(phase.kickoffTemplate).toContain(MARKER);
			}
		}
	});
	it("ralph item review and acceptance review embed the fragment", () => {
		const ralph = RALPH_LOOP.phases[0];
		expect(ralph.stepTemplates.review).toContain(MARKER);
		expect(ralph.acceptanceReviewTemplate).toContain(MARKER);
	});
	it("each review phase declares a reviewMode", () => {
		expect(SPEC_DRIVEN_DEVELOPMENT.phases[0].reviewMode).toBe("phase-review");
		expect(SPEC_DRIVEN_DEVELOPMENT.phases[1].reviewMode).toBe("phase-review");
		expect(SPEC_DRIVEN_DEVELOPMENT.phases[3].reviewMode).toBe("acceptance-review");
		expect(RALPH_LOOP.phases[0].reviewMode).toBe("chunk-review");
	});
});
