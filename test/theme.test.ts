import { describe, expect, it } from "vitest";
import { THEME, AGENT_COLOR } from "../packages/cli/src/runtime/theme.ts";

describe("THEME", () => {
	it("matches ai-cortex tokens", () => {
		expect(THEME.accent).toBe("#D97757");
		expect(THEME.select).toBe("#7FB069");
		expect(THEME.ok).toBe("green");
		expect(THEME.warn).toBe("yellow");
		expect(THEME.err).toBe("red");
		expect(THEME.muted).toBe("gray");
	});
});

describe("AGENT_COLOR", () => {
	it("claude=terracotta, codex=teal", () => {
		expect(AGENT_COLOR.claude).toBe("#D97757");
		expect(AGENT_COLOR.codex).toBe("#5FB3C9");
	});
});
