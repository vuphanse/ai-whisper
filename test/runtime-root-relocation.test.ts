import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("runtime-root relocation", () => {
	it("paths.ts no longer exports getRuntimeRoot or getBrokerSqlitePath", async () => {
		const mod: Record<string, unknown> = await import(
			"../packages/cli/src/runtime/paths.ts",
		);
		expect("getRuntimeRoot" in mod).toBe(false);
		expect("getBrokerSqlitePath" in mod).toBe(false);
	});

	it("no source file references the old per-workspace runtime path helpers", () => {
		const matches = execSync(
			"grep -rln 'getRuntimeRoot\\|getBrokerSqlitePath' packages/cli/src packages/broker/src 2>/dev/null || true",
			{ encoding: "utf8" },
		)
			.split("\n")
			.filter((l) => l.trim().length > 0);
		expect(matches).toEqual([]);
	});

	it("the runtime root is the shared per-user path", async () => {
		delete process.env.AI_WHISPER_STATE_ROOT;
		const { getStateRoot } = await import(
			"../packages/cli/src/runtime/state-root.ts",
		);
		expect(getStateRoot()).toMatch(/\/\.ai-whisper$/);
	});
});
