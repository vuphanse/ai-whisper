import { describe, expect, it } from "vitest";
import { styleOwnerCard } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

// RC2 invariant: lineCount must equal the physical rows the card actually
// occupies, and no rendered row may exceed cols-1 visible chars (or the
// terminal auto-margin adds a phantom row clearOwnerCard can't account for).
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\[[0-9;]*m/g, "");
}

describe("styleOwnerCard wrapping (RC2)", () => {
	it("wraps a long single logical line to ceil(len/contentWidth) rows", () => {
		const cols = 80;
		const contentWidth = cols - 3; // 77
		const msg = "x".repeat(600);
		const { text, lineCount } = styleOwnerCard(msg, cols);

		expect(lineCount).toBe(Math.ceil(600 / contentWidth)); // ceil(600/77)=8
		expect(text.split("\n")).toHaveLength(lineCount);
	});

	it("every rendered row has exactly contentWidth+2 visible chars and stays under cols", () => {
		const cols = 80;
		const { text } = styleOwnerCard("short\n" + "y".repeat(300), cols);
		for (const row of text.split("\n")) {
			const visible = stripAnsi(row);
			expect(visible.length).toBe(cols - 1); // 1 + (cols-3) + 1
			expect(visible.length).toBeLessThan(cols);
			expect(row.startsWith("[48;5;29m")).toBe(true);
			expect(row.endsWith("[0m")).toBe(true);
		}
	});

	it("counts wrapped rows across multiple logical lines (sum, not logical count)", () => {
		const cols = 40; // contentWidth 37
		const msg = ["a", "b".repeat(100), "c"].join("\n");
		const { text, lineCount } = styleOwnerCard(msg, cols);
		// 1 + ceil(100/37)=3 + 1 = 5 physical rows
		expect(lineCount).toBe(1 + Math.ceil(100 / 37) + 1);
		expect(text.split("\n")).toHaveLength(lineCount);
	});

	it("preserves empty logical lines as one row each", () => {
		const { lineCount } = styleOwnerCard("a\n\nb", 80);
		expect(lineCount).toBe(3);
	});

	it("short message keeps logical==physical (no regression)", () => {
		const msg = "Implement the approved plan\nKeep commits small.";
		const { lineCount } = styleOwnerCard(msg, 120);
		expect(lineCount).toBe(2);
	});

	it("degrades safely at tiny widths", () => {
		const { text, lineCount } = styleOwnerCard("hello world", 4);
		expect(lineCount).toBeGreaterThan(0);
		for (const row of text.split("\n")) {
			expect(stripAnsi(row).length).toBe(Math.max(1, 4 - 3) + 2);
		}
	});
});
