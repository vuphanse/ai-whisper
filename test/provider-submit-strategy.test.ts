import { describe, expect, it, vi } from "vitest";
import { submitInjectedProviderInput } from "../packages/cli/src/runtime/provider-submit-strategy.ts";

describe("provider submit strategy", () => {
	it("types Codex input as a short keystream before submitting", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "codex",
			text: "hi",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["h", "i", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 5);
		expect(sleep).toHaveBeenNthCalledWith(2, 5);
		expect(sleep).toHaveBeenNthCalledWith(3, 100);
	});

	it("writes Claude input in one chunk before submitting", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "claude",
			text: "tell me a joke",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["tell me a joke", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(75);
	});
});
