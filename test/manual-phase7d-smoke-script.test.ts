import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("phase 7d manual smoke script", () => {
	it("prints usage information including adopt-current-tty validation", () => {
		const scriptPath = resolve(process.cwd(), "scripts/manual/phase-7d-adopted-session-smoke.sh");
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--provider");
		expect(output).toContain("--workspace");
		expect(output).toContain("Ctrl+Z");
		expect(output).toContain("fg");
		expect(output).toContain("relay rendering");
	});

	it("documents shell resume and relay rendering as required validation points", () => {
		const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
		expect(readme).toContain("--adopt-current-tty");
		expect(readme).toContain("Ctrl+Z");
		expect(readme).toContain("fg");
	});
});
