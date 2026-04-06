import { describe, expect, it } from "vitest";
import {
	getRelayDirectiveError,
	parseRelayDirective,
} from "../packages/cli/src/runtime/relay-directive.ts";

describe("relay directive parser", () => {
	it("parses a plain codex relay", () => {
		expect(parseRelayDirective("@@codex review this plan")).toEqual({
			raw: "@@codex review this plan",
			target: "codex",
			forceNewThread: false,
			instruction: "review this plan",
		});
	});

	it("parses a forced new-thread claude relay", () => {
		expect(parseRelayDirective("@@claude[new] implement the plan")).toEqual({
			raw: "@@claude[new] implement the plan",
			target: "claude",
			forceNewThread: true,
			instruction: "implement the plan",
		});
	});

	it("returns null for normal conversation and unsupported syntax", () => {
		expect(parseRelayDirective("please review this plan")).toBeNull();
		expect(parseRelayDirective("@@claude[thread:thread_123] continue")).toBeNull();
		expect(getRelayDirectiveError("@@claude[thread:thread_123] continue")).toMatch(
			/unsupported relay syntax/i,
		);
		expect(parseRelayDirective("@@codex")).toBeNull();
	});

	it("parses @@pull as a pull directive", () => {
		const result = parseRelayDirective("@@pull");
		expect(result).not.toBeNull();
		expect(result!.target).toBe("pull");
		expect(result!.instruction).toBe("");
	});
});
