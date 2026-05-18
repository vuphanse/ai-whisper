import { describe, expect, it } from "vitest";
import { SPEC_DRIVEN_DEVELOPMENT } from "../packages/broker/src/runtime/workflow-registry.ts";

// The workflow drives real LLM agents with no human in the loop. Every
// agent-facing template must (a) tell implementers to act without asking, and
// (b) constrain reviewers to block only on concrete acceptance-criteria
// violations — otherwise the implementer defers and the reviewer nitpicks,
// and the orchestrator correctly but uselessly escalates.

const NO_ASK = /never ask|do not ask|without asking/i;
const NO_HUMAN = /no human|autonomous/i;
const APPROVE_ON_CRITERIA = /acceptance criteria/i;
const BLOCKING_ONLY = /only .*(blocking|concrete)|concrete,? .*blocking/i;
const NO_NITS = /do not raise|no stylistic|not? (raise )?(stylistic|scope|speculative)/i;

describe("spec-driven-development autonomous prompt framing", () => {
	const phases = SPEC_DRIVEN_DEVELOPMENT.phases;

	it("every implementer step (implement/fix/execute) forbids asking and states no human is present", () => {
		for (const phase of phases) {
			for (const step of ["implement", "fix", "execute"] as const) {
				const tmpl = phase.stepTemplates[step];
				if (!tmpl) continue;
				expect(tmpl, `${phase.name}.${step} no-ask`).toMatch(NO_ASK);
				expect(tmpl, `${phase.name}.${step} no-human`).toMatch(NO_HUMAN);
			}
		}
	});

	it("every review step approves on acceptance criteria and blocks only on concrete defects", () => {
		for (const phase of phases) {
			const tmpl = phase.stepTemplates.review;
			if (!tmpl) continue;
			expect(tmpl, `${phase.name}.review criteria`).toMatch(
				APPROVE_ON_CRITERIA,
			);
			expect(tmpl, `${phase.name}.review blocking-only`).toMatch(
				BLOCKING_ONLY,
			);
			expect(tmpl, `${phase.name}.review no-nits`).toMatch(NO_NITS);
		}
	});

	it("kickoff templates carry the same framing as their initial step", () => {
		for (const phase of phases) {
			const isReviewKickoff = phase.initialHandoffStep === "review";
			if (isReviewKickoff) {
				expect(phase.kickoffTemplate, `${phase.name} kickoff`).toMatch(
					APPROVE_ON_CRITERIA,
				);
			} else {
				expect(phase.kickoffTemplate, `${phase.name} kickoff`).toMatch(
					NO_ASK,
				);
			}
		}
	});

	it("plan-execution does not hardcode pnpm and references the plan's own verification", () => {
		const exec = phases.find((p) => p.name === "plan-execution");
		const tmpl = exec?.stepTemplates.execute ?? "";
		expect(tmpl).not.toMatch(/pnpm test/);
		expect(tmpl).toMatch(/verification|the plan'?s? .*test|tests? the plan/i);
	});
});
