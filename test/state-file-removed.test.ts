import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

describe("state-file removal", () => {
	it("state-file.ts no longer exists", () => {
		const p = path.join(process.cwd(), "packages/cli/src/runtime/state-file.ts");
		expect(existsSync(p)).toBe(false);
	});

	it("no source file imports state-file", async () => {
		const { execSync } = await import("node:child_process");
		const out = execSync(
			"grep -rln 'state-file' packages/cli/src 2>/dev/null || true",
			{ encoding: "utf8" },
		).trim();
		expect(out).toBe("");
	});
});
