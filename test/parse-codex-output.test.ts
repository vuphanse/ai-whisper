import { describe, expect, it } from "vitest";
import { parseCodexOutput } from "../packages/adapter-codex/src/parse-codex-output.ts";

describe("parseCodexOutput", () => {
	it("extracts the provider reply JSON when stdout contains surrounding CLI noise", () => {
		const stdout = [
			"Thinking...",
			'{"debug":"ignore this wrapper"}',
			'{"kind":"answer","content":"ok","transitionIntent":"completed"}',
			"Done.",
		].join("\n");

		expect(parseCodexOutput(stdout)).toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});
});
