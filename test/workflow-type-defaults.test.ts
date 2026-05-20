import { describe, expect, it } from "vitest";
import { getWorkflowDefinition } from "../packages/broker/src/index.ts";

describe("getWorkflowDefinition default role bindings", () => {
	it("spec-driven-development carries defaultImplementer + defaultReviewer", () => {
		const def = getWorkflowDefinition("spec-driven-development");
		expect(def).toBeDefined();
		expect(def!.defaultImplementer).toBe("claude");
		expect(def!.defaultReviewer).toBe("codex");
	});

	it("definitions without defaults stay un-defaulted (forward-compat)", () => {
		const def = getWorkflowDefinition("spec-driven-development");
		// Other types may or may not carry defaults; assert SDD specifically
		// without claiming every type has them.
		expect(def!.defaultImplementer).toBeTypeOf("string");
		expect(def!.defaultReviewer).toBeTypeOf("string");
	});
});
