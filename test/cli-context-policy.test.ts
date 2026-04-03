import { describe, expect, it } from "vitest";
import { requiresExplicitArtifacts } from "../packages/cli/src/runtime/context-policy.ts";

describe("cli context policy", () => {
	it("requires artifacts for plan and diff actions on new threads", () => {
		expect(requiresExplicitArtifacts("review_plan")).toBe(true);
		expect(requiresExplicitArtifacts("implement_plan")).toBe(true);
		expect(requiresExplicitArtifacts("review_diff")).toBe(true);
		expect(requiresExplicitArtifacts("validate_against_plan")).toBe(true);
		expect(requiresExplicitArtifacts("answer_question")).toBe(false);
		expect(requiresExplicitArtifacts("request_clarification")).toBe(false);
	});
});
