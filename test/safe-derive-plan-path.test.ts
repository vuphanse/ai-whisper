import { describe, expect, it } from "vitest";
import { safeDerivePlanPath } from "../packages/broker/src/control/workflow-control.ts";

// The plan-writing kickoff renders {planPath} from safeDerivePlanPath. If it
// ever returns specPath, the instruction becomes "write the plan to the spec
// file" and the implementer correctly refuses → workflow halts. The fallback
// must always be a distinct sibling.

describe("safeDerivePlanPath", () => {
	it("delegates to the -design.md convention when it applies", () => {
		expect(
			safeDerivePlanPath(
				"docs/superpowers/specs/2026-04-21-foo-design.md",
				"2026-04-22T10:00:00Z",
			),
		).toBe("docs/superpowers/plans/2026-04-22-foo.md");
	});

	it("falls back to a distinct sibling .plan.md for a plain spec.md", () => {
		const specPath = "/tmp/aiw-sdd-smoke/ws/spec.md";
		const planPath = safeDerivePlanPath(specPath, "2026-05-19T00:00:00Z");
		expect(planPath).toBe("/tmp/aiw-sdd-smoke/ws/spec.plan.md");
		expect(planPath).not.toBe(specPath);
	});

	it("never returns specPath for non-conforming inputs", () => {
		for (const specPath of [
			"/x/spec.md",
			"spec.md",
			"/x/SPEC",
			"/a/b/my.feature.md",
			"plan.md",
		]) {
			const planPath = safeDerivePlanPath(specPath, "not-a-date");
			expect(planPath, specPath).not.toBe(specPath);
			expect(planPath.endsWith(".plan.md"), specPath).toBe(true);
		}
	});

	it("strips only the final extension when forming the sibling", () => {
		expect(safeDerivePlanPath("/a/b/my.feature.md", "x")).toBe(
			"/a/b/my.feature.plan.md",
		);
		expect(safeDerivePlanPath("/x/SPEC", "x")).toBe("/x/SPEC.plan.md");
		expect(safeDerivePlanPath("spec.md", "x")).toBe("spec.plan.md");
	});
});
