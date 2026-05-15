import { describe, expect, it } from "vitest";
import { readProcessStartTime } from "../packages/cli/src/runtime/process-start-time.ts";

describe("process-start-time", () => {
	it("returns a non-empty string or null for the current process", () => {
		const v = readProcessStartTime(process.pid);
		expect(typeof v === "string" || v === null).toBe(true);
		if (typeof v === "string") expect(v.length).toBeGreaterThan(0);
	});

	it("returns null for a PID that does not exist", () => {
		expect(readProcessStartTime(99999999)).toBeNull();
	});
});
