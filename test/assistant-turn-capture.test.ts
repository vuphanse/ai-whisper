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

	it("falls back when output is only ansi noise or still streaming", () => {
		const capture = createAssistantTurnCapture();
		capture.recordProviderOutput("\u001b[2K\r");

		expect(capture.extractLatestAssistantTurn()).toEqual({
			confidence: "low",
			text: null,
		});
	});
});
