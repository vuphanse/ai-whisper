import { describe, expect, it } from "vitest";
import {
	getWorkflowDefinition,
	renderTemplate,
	RALPH_ITEM_DELIVERED_MARKER,
	RALPH_GOAL_COMPLETE_MARKER,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("ralph-loop workflow definition", () => {
	const def = getWorkflowDefinition("ralph-loop");

	it("is registered with implementer-first, reviewer-gated single looping phase", () => {
		expect(def).toBeDefined();
		expect(def!.defaultImplementer).toBe("claude");
		expect(def!.defaultReviewer).toBe("codex");
		expect(def!.phases).toHaveLength(1);
		const phase = def!.phases[0]!;
		expect(phase.initialHandoffStep).toBe("implement");
		expect(phase.reviewerRole).toBe("reviewer");
		expect(phase.evaluatorPromptKey).toBe("ralph-loop");
		expect(phase.repeatUntilComplete).toBe(true);
		expect(phase.maxIterations).toBeGreaterThan(0);
		expect(phase.maxRounds).toBeGreaterThan(0);
	});

	it("kickoff + review + acceptance templates reference the run dir and goal", () => {
		const phase = def!.phases[0]!;
		expect(phase.kickoffTemplate).toContain("{ralphDir}");
		expect(phase.kickoffTemplate).toContain("{specPath}");
		expect(phase.acceptanceReviewTemplate).toBeDefined();
		expect(phase.kickoffTemplate).toContain(RALPH_ITEM_DELIVERED_MARKER);
		expect(phase.kickoffTemplate).toContain(RALPH_GOAL_COMPLETE_MARKER);
	});

	it("renders {ralphDir} via renderTemplate", () => {
		const out = renderTemplate(def!.phases[0]!.kickoffTemplate, {
			ralphDir: "/ws/.ai-whisper/ralph/wf_123",
			specPath: "/ws/GOAL.md",
		});
		expect(out).toContain("/ws/.ai-whisper/ralph/wf_123");
		expect(out).not.toContain("{ralphDir}");
	});

	it("markers are the exact agreed tokens", () => {
		expect(RALPH_ITEM_DELIVERED_MARKER).toBe("[[RALPH:ITEM-DELIVERED]]");
		expect(RALPH_GOAL_COMPLETE_MARKER).toBe("[[RALPH:GOAL-COMPLETE]]");
	});

	it("step templates cover fix handback marker, LEARNINGS.md, and distinct review vs acceptance gate", () => {
		const phase = def!.phases[0]!;
		const fixTemplate = phase.stepTemplates.fix!;
		const reviewTemplate = phase.stepTemplates.review!;
		const acceptanceTemplate = phase.acceptanceReviewTemplate!;

		// fix handback must emit item marker
		expect(fixTemplate).toContain(RALPH_ITEM_DELIVERED_MARKER);

		// fix step appends generalizable lessons to LEARNINGS.md
		expect(fixTemplate).toContain("LEARNINGS.md");

		// item review and acceptance gate are distinct strings
		expect(reviewTemplate).toBeDefined();
		expect(acceptanceTemplate).toBeDefined();
		expect(reviewTemplate).not.toBe(acceptanceTemplate);

		// acceptance template covers the whole goal, not just a single chunk
		expect(acceptanceTemplate).toContain("ENTIRE");
	});
});
