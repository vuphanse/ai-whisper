import { describe, expect, it } from "vitest";
import { normalizeTerminalInput } from "../packages/cli/src/runtime/terminal-input-normalizer.ts";

const ESC = "\x1b";

function normalize(raw: string): string {
	return normalizeTerminalInput({ raw, state: {} }).text;
}

describe("normalizeTerminalInput — Kitty keyboard progressive enhancement", () => {
	it("passes plain legacy arrow sequences through unchanged", () => {
		expect(normalize(`${ESC}[A`)).toBe(`${ESC}[A`);
		expect(normalize(`${ESC}[B`)).toBe(`${ESC}[B`);
		expect(normalize(`${ESC}[C`)).toBe(`${ESC}[C`);
		expect(normalize(`${ESC}[D`)).toBe(`${ESC}[D`);
	});

	it("drops CSI arrow sequences carrying a release-event subparam (event-type 3)", () => {
		// REPORT_EVENT_TYPES: up release = ESC[1;1:3A — downstream provider PTYs
		// (codex, claude readline) can't parse this and treat it as garbage.
		expect(normalize(`${ESC}[1;1:3A`)).toBe("");
		expect(normalize(`${ESC}[1;1:3B`)).toBe("");
		expect(normalize(`${ESC}[1;1:3C`)).toBe("");
		expect(normalize(`${ESC}[1;1:3D`)).toBe("");
	});

	it("drops CSI tilde-terminated sequences carrying a release-event subparam", () => {
		// PgUp/PgDn/Home/End/Insert/Delete under REPORT_EVENT_TYPES.
		expect(normalize(`${ESC}[5;1:3~`)).toBe("");
		expect(normalize(`${ESC}[6;1:3~`)).toBe("");
		expect(normalize(`${ESC}[3;1:3~`)).toBe("");
	});

	it("strips :<event> subparam from press (event-type 1) arrow sequences", () => {
		// Leaves a legacy xterm-style modified arrow the downstream can parse.
		expect(normalize(`${ESC}[1;1:1A`)).toBe(`${ESC}[1;1A`);
		expect(normalize(`${ESC}[1;2:1B`)).toBe(`${ESC}[1;2B`);
	});

	it("strips :<event> subparam from repeat (event-type 2) arrow sequences", () => {
		expect(normalize(`${ESC}[1;1:2C`)).toBe(`${ESC}[1;1C`);
		expect(normalize(`${ESC}[1;1:2D`)).toBe(`${ESC}[1;1D`);
	});

	it("keeps press survives + release drops in the exact sequence the user observed", () => {
		// Up arrow keypress in a progressive-enhanced terminal: legacy press + enhanced release
		expect(normalize(`${ESC}[A${ESC}[1;1:3A`)).toBe(`${ESC}[A`);
		expect(normalize(`${ESC}[B${ESC}[1;1:3B`)).toBe(`${ESC}[B`);
	});

	it("does not touch CSI u keyboard sequences (those flow through existing decoder)", () => {
		// Plain CSI u: unicode codepoint 97 = 'a', no event-type subparam → text input.
		// Existing decoder handles this; ensure the new strip doesn't interfere.
		expect(normalize(`${ESC}[97u`)).toBe("a");
	});
});
