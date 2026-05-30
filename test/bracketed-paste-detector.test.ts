import { describe, expect, it } from "vitest";
import { createBracketedPasteDetector } from "../packages/cli/src/runtime/bracketed-paste-detector.ts";

describe("bracketed-paste detector", () => {
	it("defaults to disabled before any output is observed", () => {
		const d = createBracketedPasteDetector();
		expect(d.enabled).toBe(false);
	});

	it("enables when codex emits the DECSET 2004 enable sequence", () => {
		const d = createBracketedPasteDetector();
		d.observe("some chrome\x1b[?2004hmore");
		expect(d.enabled).toBe(true);
	});

	it("disables when codex emits the DECSET 2004 reset sequence", () => {
		const d = createBracketedPasteDetector();
		d.observe("\x1b[?2004h");
		d.observe("\x1b[?2004l");
		expect(d.enabled).toBe(false);
	});

	it("uses the last toggle within a single chunk (enable then reset → disabled)", () => {
		const d = createBracketedPasteDetector();
		d.observe("\x1b[?2004h ... \x1b[?2004l");
		expect(d.enabled).toBe(false);
	});

	it("uses the last toggle within a single chunk (reset then enable → enabled)", () => {
		const d = createBracketedPasteDetector();
		d.observe("\x1b[?2004l ... \x1b[?2004h");
		expect(d.enabled).toBe(true);
	});

	it("leaves state unchanged on a chunk with no toggle", () => {
		const d = createBracketedPasteDetector();
		d.observe("\x1b[?2004h");
		d.observe("ordinary output with no paste-mode toggle");
		expect(d.enabled).toBe(true);
	});
});
