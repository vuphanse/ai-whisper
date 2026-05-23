import { describe, expect, it } from "vitest";
import { liveReviewCommitRange } from "../packages/broker/src/control/workflow-control.ts";

// Regression: the code-review prompt must NOT pin the reviewer to a frozen head
// SHA (which went stale across fix rounds and made codex review an old checkout).
// The upper bound is a live `HEAD`, anchored to the real pre-work base.
describe("liveReviewCommitRange — live HEAD upper bound, never a frozen head", () => {
	it("anchors to baseBeforeExecution with a live HEAD upper bound", () => {
		expect(liveReviewCommitRange({ baseBeforeExecution: "814e49db75e157a76280d997b33ae4a0095ec9d5" })).toBe(
			"814e49db75e157a76280d997b33ae4a0095ec9d5..HEAD",
		);
	});

	it("ignores a stale frozen commitRange and still resolves to base..HEAD", () => {
		expect(
			liveReviewCommitRange({
				baseBeforeExecution: "814e49d",
				commitRange: "814e49d..0bd83b7", // stale frozen range from a prior round
			}),
		).toBe("814e49d..HEAD");
	});

	it("falls back to HEAD when no base is known", () => {
		expect(liveReviewCommitRange({})).toBe("HEAD");
	});
});
