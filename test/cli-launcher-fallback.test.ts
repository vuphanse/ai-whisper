import { describe, expect, it } from "vitest";
import { chooseLaunchMode } from "../packages/cli/src/runtime/launcher.ts";

describe("launcher fallback", () => {
	it("falls back to separate terminals when tmux is unavailable", () => {
		expect(chooseLaunchMode({ tmuxAvailable: false, forceNoTmux: false, forceNoLaunch: false })).toBe(
			"terminals",
		);
	});
});
