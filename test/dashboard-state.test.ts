import { describe, expect, it } from "vitest";
import { estimateTokens } from "../packages/cli/src/runtime/dashboard-state.ts";

describe("estimateTokens", () => {
	it("is ceil(chars / 4), deterministic, zero for empty/negative", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(1)).toBe(1);
		expect(estimateTokens(4)).toBe(1);
		expect(estimateTokens(5)).toBe(2);
		expect(estimateTokens(4000)).toBe(1000);
		expect(estimateTokens(-10)).toBe(0);
		expect(estimateTokens(Number.NaN)).toBe(0);
	});
});
