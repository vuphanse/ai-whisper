import { describe, expect, it } from "vitest";
import { composeResumeNotice } from "../packages/broker/src/control/workflow-control.ts";

describe("composeResumeNotice", () => {
	it("changed files only", () => {
		const n = composeResumeNotice({ changedFiles: ["a.md", "b.ts"], message: null });
		expect(n).toContain("While paused, the operator modified these files:");
		expect(n).toContain("- a.md");
		expect(n).toContain("- b.ts");
		expect(n).toContain("Re-read them before continuing.");
		expect(n).not.toContain("Operator note:");
	});

	it("message only", () => {
		const n = composeResumeNotice({ changedFiles: [], message: "fixed the spec glitch" });
		expect(n).toContain("Operator note: fixed the spec glitch");
		expect(n).not.toContain("modified these files");
	});

	it("both files and message", () => {
		const n = composeResumeNotice({ changedFiles: ["a.md"], message: "see a.md" });
		expect(n).toContain("- a.md");
		expect(n).toContain("Operator note: see a.md");
	});

	it("neither → null (no notice)", () => {
		expect(composeResumeNotice({ changedFiles: [], message: null })).toBeNull();
		expect(composeResumeNotice({ changedFiles: [], message: "   " })).toBeNull();
	});
});
