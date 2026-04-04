import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("phase 6 manual smoke script", () => {
	it("prints usage information", () => {
		const scriptPath = resolve(
			process.cwd(),
			"scripts/manual/phase-6-live-session-smoke.sh",
		);
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--provider");
		expect(output).toContain("--workspace");
	});
});
