import { describe, expect, it } from "vitest";
// Direct module-path import (matches the existing evaluator test); these symbols
// are NOT on the cli package index.
import {
	separateReviewSections,
	REVIEW_SYSTEM_PROMPT,
} from "../packages/cli/src/runtime/relay-orchestrator-evaluator.ts";

describe("separateReviewSections", () => {
	it("splits the Non-blocking risks block out of the body", () => {
		const text = [
			"Review matrix:",
			"| R | E | T | Pass |",
			"",
			"Approved. All criteria met.",
			"",
			"Non-blocking risks:",
			"- may break under concurrent writes",
		].join("\n");
		const { body, risks } = separateReviewSections(text);
		expect(body).toContain("Approved.");
		expect(body).not.toContain("concurrent writes");
		expect(risks).toContain("concurrent writes");
	});
	it("returns empty risks when the section is absent", () => {
		const { body, risks } = separateReviewSections("Approved. Looks good.");
		expect(body).toContain("Approved.");
		expect(risks).toBe("");
	});
	it("treats 'Non-blocking risks: None.' as no risks content in body", () => {
		const { body, risks } = separateReviewSections("Approved.\n\nNon-blocking risks:\n- None.");
		expect(body).not.toMatch(/Non-blocking risks/);
		expect(risks).toBe("");
	});
	it("splits on the LAST Non-blocking risks header when the phrase appears earlier", () => {
		const text = [
			"Review matrix:",
			"| note: see Non-blocking risks: below |",
			"",
			"Approved.",
			"",
			"Non-blocking risks:",
			"- real risk here",
		].join("\n");
		const { body, risks } = separateReviewSections(text);
		expect(risks).toContain("real risk here");
		expect(risks).not.toContain("see Non-blocking risks: below");
		expect(body).toContain("Approved.");
	});
});

describe("REVIEW_SYSTEM_PROMPT rules", () => {
	it("states risks are informational, not findings", () => {
		expect(REVIEW_SYSTEM_PROMPT).toMatch(/non-blocking risks/i);
		expect(REVIEW_SYSTEM_PROMPT).toMatch(/informational|not.*findings/i);
	});
	it("maps blocked/cannot-proceed to escalate", () => {
		expect(REVIEW_SYSTEM_PROMPT).toMatch(/cannot proceed|blocked/i);
		expect(REVIEW_SYSTEM_PROMPT).toMatch(/escalate/i);
	});
});

it.skip("live: approval-plus-risks classifies as approve (run with real key)", async () => {
	// manual eval; requires a configured real evaluator (ANTHROPIC_API_KEY)
});
