import { describe, expect, it, vi } from "vitest";
import {
	createMountedTurnOwnedRelay,
	computeOrderedJaccard,
	classifyCapture,
} from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

// ---------------------------------------------------------------------------
// Ordered Jaccard + capture classification
// ---------------------------------------------------------------------------

describe("computeOrderedJaccard", () => {
	it("returns 1.0 for identical texts", () => {
		expect(computeOrderedJaccard("the quick brown fox", "the quick brown fox")).toBeCloseTo(1.0, 2);
	});

	it("returns 0 when both texts are empty", () => {
		expect(computeOrderedJaccard("", "")).toBe(0);
	});

	it("returns 0 when neither text has words of length >= 4", () => {
		expect(computeOrderedJaccard("hi ok no", "hi ok no")).toBe(0);
	});

	it("penalises reversed word order below 0.6", () => {
		const a = "alpha beta gamma delta epsilon";
		const b = "epsilon delta gamma beta alpha";
		expect(computeOrderedJaccard(a, b)).toBeLessThan(0.6);
	});

	it("scores same-order overlap at or above 0.6", () => {
		const a = "implement approved plan keep commits small verify tests pass";
		const b = "implement approved plan keep commits small verify tests pass done";
		expect(computeOrderedJaccard(a, b)).toBeGreaterThanOrEqual(0.6);
	});
});

describe("classifyCapture", () => {
	it("returns no_response_captured when both signals empty", () => {
		expect(classifyCapture({ confidence: "low", text: null }, null)).toBe(
			"no_response_captured",
		);
		expect(classifyCapture({ confidence: "high", text: "" }, "")).toBe(
			"no_response_captured",
		);
	});

	it("returns ok when high confidence + clipboard non-empty + jaccard >= 0.6", () => {
		const text = "implement approved plan keep commits small verify tests pass";
		expect(classifyCapture({ confidence: "high", text }, text)).toBe("ok");
	});

	it("returns no_response_captured_confidently when confidence is low", () => {
		expect(
			classifyCapture({ confidence: "low", text: "something here" }, "something here"),
		).toBe("no_response_captured_confidently");
	});

	it("returns no_response_captured_confidently when jaccard < 0.6", () => {
		const turnText = "alpha beta gamma delta epsilon zeta eta theta";
		const clipText = "theta eta zeta epsilon delta gamma beta alpha";
		expect(classifyCapture({ confidence: "high", text: turnText }, clipText)).toBe(
			"no_response_captured_confidently",
		);
	});

	it("returns no_response_captured_confidently when clipboard is empty but turn text exists", () => {
		expect(classifyCapture({ confidence: "high", text: "some output here" }, null)).toBe(
			"no_response_captured_confidently",
		);
	});
});
