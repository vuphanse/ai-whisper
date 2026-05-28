import { describe, expect, it } from "vitest";
import { abbreviateWorkflowType } from "../packages/cli/src/runtime/dashboard-view.tsx";

describe("abbreviateWorkflowType", () => {
	it("maps the three known workflow types to short badges", () => {
		expect(abbreviateWorkflowType("complex-bug-fixing")).toBe("bugfix");
		expect(abbreviateWorkflowType("spec-driven-development")).toBe("sdd");
		expect(abbreviateWorkflowType("ralph-loop")).toBe("ralph");
	});

	it("falls back to the first dash-segment for unknown types", () => {
		expect(abbreviateWorkflowType("code-review")).toBe("code");
		expect(abbreviateWorkflowType("foo-bar-baz")).toBe("foo");
	});

	it("caps unknown fallback at 8 chars", () => {
		expect(abbreviateWorkflowType("longworkflowtype")).toBe("longwork");
		expect(abbreviateWorkflowType("nodash")).toBe("nodash");
	});
});
