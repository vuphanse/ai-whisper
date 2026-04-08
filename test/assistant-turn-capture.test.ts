import { describe, expect, it } from "vitest";
import { createAssistantTurnCapture } from "../packages/cli/src/runtime/assistant-turn-capture.ts";

describe("assistant turn capture", () => {
	it("returns the latest completed assistant output block", () => {
		const capture = createAssistantTurnCapture();
		capture.recordProviderOutput("Thinking...\r");
		capture.recordProviderOutput("Implemented the plan.\n");
		capture.recordProviderOutput("Added tests.\n");
		capture.finishAssistantTurn();

		expect(capture.extractLatestAssistantTurn()).toEqual({
			confidence: "high",
			text: "Implemented the plan.\nAdded tests.",
		});
	});

	it("handles CRLF output from PTY (onlcr mode) correctly", () => {
		const capture = createAssistantTurnCapture();
		// PTY converts \n to \r\n — simulate real PTY output
		capture.recordProviderOutput("Thinking...\r\r\n");
		capture.recordProviderOutput("Implemented the plan.\r\n");
		capture.recordProviderOutput("Added tests.\r\n");
		capture.finishAssistantTurn();

		expect(capture.extractLatestAssistantTurn()).toEqual({
			confidence: "high",
			text: "Implemented the plan.\nAdded tests.",
		});
	});

	it("falls back when output is only ansi noise or still streaming", () => {
		const capture = createAssistantTurnCapture();
		capture.recordProviderOutput("\u001b[2K\r");

		expect(capture.extractLatestAssistantTurn()).toEqual({
			confidence: "low",
			text: null,
		});
	});

	it("detects visible assistant output before a turn is formally completed", () => {
		const capture = createAssistantTurnCapture();

		capture.recordProviderOutput("Implemented the plan.\r\n");
		expect(capture.hasVisibleAssistantTurn()).toBe(true);

		capture.reset();
		capture.recordProviderOutput("\u001b[2K\r");
		expect(capture.hasVisibleAssistantTurn()).toBe(false);
	});
});
