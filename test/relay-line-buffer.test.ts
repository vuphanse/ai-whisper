import { describe, expect, it } from "vitest";
import { createRelayLineBuffer } from "../packages/cli/src/runtime/relay-line-buffer.ts";

function makeBuffer() {
	return createRelayLineBuffer({
		getError: (line) =>
			line.includes("[thread:")
				? "[ai-whisper] Unsupported relay syntax."
				: null,
		isRelayCandidate: (line) =>
			["@@codex", "@@claude"].some(
				(target) => target.startsWith(line) || line.startsWith(target),
			),
	});
}

describe("relay line buffer", () => {
	it("passes through ordinary lines immediately when they do not start with @", () => {
		const buffer = makeBuffer();

		expect(buffer.push("h")).toEqual([{ kind: "passthrough", data: "h" }]);
		expect(buffer.push("e")).toEqual([{ kind: "passthrough", data: "e" }]);
		expect(buffer.push("llo\n")).toEqual([
			{ kind: "passthrough", data: "l" },
			{ kind: "passthrough", data: "l" },
			{ kind: "passthrough", data: "o" },
			{ kind: "passthrough", data: "\n" },
		]);
	});

	it("buffers split relay chunks until newline completes the directive", () => {
		const buffer = makeBuffer();

		expect(
			buffer.push("@@cod").every((decision) => decision.kind === "buffering"),
		).toBe(true);
		expect(
			buffer
				.push("ex review this plan")
				.every((decision) => decision.kind === "buffering"),
		).toBe(true);
		expect(buffer.push("\n")).toEqual([
			{ kind: "relay", line: "@@codex review this plan" },
		]);
	});

	it("falls back to passthrough when backspace erases the relay prefix", () => {
		const buffer = makeBuffer();

		buffer.push("@@");
		const result = buffer.push("\u007fhello\n");

		expect(result).toContainEqual({ kind: "passthrough", data: "\u007f" });
		expect(result).toContainEqual({ kind: "passthrough", data: "@h" });
		expect(result.filter((decision) => decision.kind === "relay")).toHaveLength(
			0,
		);
		expect(result.at(-1)).toEqual({ kind: "passthrough", data: "\n" });
	});

	it("strips carriage returns and rejects unsupported advanced syntax locally", () => {
		const buffer = makeBuffer();

		const result = buffer.push("@@codex[thread:thread_123] continue\r\n");

		expect(result.at(-1)).toEqual({
			kind: "error",
			message: "[ai-whisper] Unsupported relay syntax.",
		});
	});

	it("treats carriage return as enter for ordinary input", () => {
		const buffer = makeBuffer();

		expect(buffer.push("h")).toEqual([{ kind: "passthrough", data: "h" }]);
		expect(buffer.push("i\r")).toEqual([
			{ kind: "passthrough", data: "i" },
			{ kind: "passthrough", data: "\r" },
		]);
	});

	it("treats carriage return as enter for relay directives", () => {
		const buffer = makeBuffer();

		expect(
			buffer
				.push("@@claude hello\r")
				.some((decision) => decision.kind === "relay"),
		).toBe(true);
	});
});
