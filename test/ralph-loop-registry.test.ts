import { describe, expect, it } from "vitest";
import {
	getWorkflowDefinition,
	renderTemplate,
	ralphFinalLineMarker,
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

	// Spec §11 / acceptance criterion 2 — the anti-amnesia obligations must be pinned
	// to committed coverage so a regression dropping them from the templates fails here.
	it("kickoff template instructs reading + re-orienting from both memory files", () => {
		const kickoff = def!.phases[0]!.stepTemplates.implement!;
		expect(kickoff).toContain("PROGRESS.md");
		expect(kickoff).toContain("LEARNINGS.md");
		// treat the files as ground truth and re-orient from them, not prior conversation
		expect(kickoff).toMatch(/re-?orient/i);
		expect(kickoff).toMatch(/ground truth/i);
	});

	it("kickoff template instructs maintaining PROGRESS.md each item", () => {
		const kickoff = def!.phases[0]!.stepTemplates.implement!;
		expect(kickoff).toMatch(/update PROGRESS\.md/i);
	});

	it("fix template instructs appending a GENERALIZABLE lesson to LEARNINGS.md", () => {
		const fixTemplate = def!.phases[0]!.stepTemplates.fix!;
		expect(fixTemplate).toContain("LEARNINGS.md");
		expect(fixTemplate).toMatch(/generaliz/i);
	});
});

// Spec §5.4/§7 — completion is signaled by the marker on the FINAL non-empty line,
// not by a substring anywhere in the handback. This deterministic helper is the
// authoritative completion signal and must agree with the evaluator's routing.
describe("ralphFinalLineMarker", () => {
	it("returns GOAL-COMPLETE when it is the final non-empty line", () => {
		expect(ralphFinalLineMarker(`done.\n${RALPH_GOAL_COMPLETE_MARKER}`)).toBe(RALPH_GOAL_COMPLETE_MARKER);
		// trailing blank lines / whitespace are tolerated
		expect(ralphFinalLineMarker(`done.\n  ${RALPH_GOAL_COMPLETE_MARKER}  \n\n`)).toBe(
			RALPH_GOAL_COMPLETE_MARKER,
		);
	});

	it("returns ITEM-DELIVERED when it is the final non-empty line", () => {
		expect(ralphFinalLineMarker(`chunk done.\n${RALPH_ITEM_DELIVERED_MARKER}`)).toBe(
			RALPH_ITEM_DELIVERED_MARKER,
		);
	});

	it("goal marker quoted earlier + item marker final line → ITEM-DELIVERED (not goal)", () => {
		const handback = `The loop ends when I emit ${RALPH_GOAL_COMPLETE_MARKER}, but work remains.\n${RALPH_ITEM_DELIVERED_MARKER}`;
		expect(ralphFinalLineMarker(handback)).toBe(RALPH_ITEM_DELIVERED_MARKER);
	});

	it("goal marker not on the final line (content after it) → null", () => {
		expect(ralphFinalLineMarker(`${RALPH_GOAL_COMPLETE_MARKER}\nActually, I have a question…`)).toBeNull();
	});

	it("no marker → null", () => {
		expect(ralphFinalLineMarker("just some prose with no marker")).toBeNull();
	});
});
