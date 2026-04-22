import { describe, expect, it } from "vitest";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
	SUPERPOWERS_FEATURE_DEVELOPMENT,
} from "../packages/broker/src/runtime/workflow-registry.ts";

describe("workflow-registry", () => {
	it("has superpowers-feature-development with 4 phases", () => {
		const def = getWorkflowDefinition("superpowers-feature-development");
		expect(def).toBeDefined();
		expect(def?.phases).toHaveLength(4);
		expect(def?.phases.map((p) => p.name)).toEqual([
			"spec-refining",
			"plan-writing",
			"plan-execution",
			"code-review",
		]);
	});

	it("each phase has a non-empty stepTemplate for its initialHandoffStep", () => {
		const def = SUPERPOWERS_FEATURE_DEVELOPMENT;
		for (const phase of def.phases) {
			const template = phase.stepTemplates[phase.initialHandoffStep];
			expect(template, `phase ${phase.name}`).toBeTruthy();
			expect(template?.length).toBeGreaterThan(10);
		}
	});

	it("plan-execution has reviewerRole=null and maxRounds=1", () => {
		const def = SUPERPOWERS_FEATURE_DEVELOPMENT;
		const exec = def.phases.find((p) => p.name === "plan-execution");
		expect(exec?.reviewerRole).toBeNull();
		expect(exec?.maxRounds).toBe(1);
		expect(exec?.initialHandoffStep).toBe("execute");
	});

	it("listWorkflowTypes includes the one registered type", () => {
		expect(listWorkflowTypes()).toContain("superpowers-feature-development");
	});
});
