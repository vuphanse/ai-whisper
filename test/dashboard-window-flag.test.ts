import { describe, expect, it } from "vitest";
import { parseDashboardWindow } from "../packages/cli/src/runtime/dashboard.ts";

describe("parseDashboardWindow", () => {
	it("parses raw milliseconds (default unit)", () => {
		expect(parseDashboardWindow("1800000")).toBe(1_800_000);
		expect(parseDashboardWindow("250ms")).toBe(250);
	});

	it("parses seconds / minutes / hours / days", () => {
		expect(parseDashboardWindow("45s")).toBe(45 * 1_000);
		expect(parseDashboardWindow("30m")).toBe(30 * 60_000);
		expect(parseDashboardWindow("2h")).toBe(2 * 3_600_000);
		expect(parseDashboardWindow("1d")).toBe(86_400_000);
	});

	it("accepts decimals", () => {
		expect(parseDashboardWindow("1.5h")).toBe(1.5 * 3_600_000);
	});

	it("'all' / 'max' / '∞' return MAX_SAFE_INTEGER (no-window sentinel)", () => {
		expect(parseDashboardWindow("all")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseDashboardWindow("max")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseDashboardWindow("∞")).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("is case-insensitive and trims whitespace", () => {
		expect(parseDashboardWindow("  2H ")).toBe(2 * 3_600_000);
		expect(parseDashboardWindow("ALL")).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("returns null for unparseable / non-positive / undefined input", () => {
		expect(parseDashboardWindow(undefined)).toBeNull();
		expect(parseDashboardWindow("")).toBeNull();
		expect(parseDashboardWindow("abc")).toBeNull();
		expect(parseDashboardWindow("0")).toBeNull();
		expect(parseDashboardWindow("-5m")).toBeNull();
		expect(parseDashboardWindow("30 m")).toBeNull(); // internal whitespace rejected
	});
});
