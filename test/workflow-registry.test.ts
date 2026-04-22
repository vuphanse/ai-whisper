import { describe, expect, it } from "vitest";
import {
	derivePlanPath,
	getWorkflowDefinition,
	listWorkflowTypes,
	renderTemplate,
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

describe("renderTemplate", () => {
	it("replaces known keys", () => {
		expect(renderTemplate("hello {name}", { name: "world" })).toBe(
			"hello world",
		);
	});

	it("leaves unknown keys literal", () => {
		expect(renderTemplate("{known} and {unknown}", { known: "a" })).toBe(
			"a and {unknown}",
		);
	});

	it("replaces multiple occurrences", () => {
		expect(renderTemplate("{x}-{x}-{x}", { x: "q" })).toBe("q-q-q");
	});

	it("single-pass: values containing a placeholder-like token are not re-rendered", () => {
		expect(renderTemplate("{a}", { a: "{b}", b: "zzz" })).toBe("{b}");
	});
});

describe("derivePlanPath", () => {
	it("derives a plan path from a dated design spec", () => {
		expect(
			derivePlanPath(
				"docs/superpowers/specs/2026-04-21-foo-design.md",
				"2026-04-22T10:00:00Z",
			),
		).toBe("docs/superpowers/plans/2026-04-22-foo.md");
	});

	it("derives a plan path from an undated design spec", () => {
		expect(
			derivePlanPath("docs/superpowers/specs/foo-design.md", "2026-04-22"),
		).toBe("docs/superpowers/plans/2026-04-22-foo.md");
	});

	it("throws on a non-design spec path", () => {
		expect(() =>
			derivePlanPath("docs/superpowers/specs/foo.md", "2026-04-22"),
		).toThrow(/must end with "-design.md"/);
	});

	it("throws on a non-ISO date", () => {
		expect(() =>
			derivePlanPath("docs/superpowers/specs/foo-design.md", "not-a-date"),
		).toThrow(/must start with YYYY-MM-DD/);
	});
});
