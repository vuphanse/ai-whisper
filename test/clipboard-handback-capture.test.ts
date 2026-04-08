import { describe, expect, it, vi } from "vitest";
import { captureClipboardHandback } from "../packages/cli/src/runtime/clipboard-handback-capture.ts";

describe("clipboard handback capture", () => {
	it("returns the changed clipboard text after triggering /copy", async () => {
		const triggerCopy = vi.fn();
		const readClipboard = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("before")
			.mockResolvedValueOnce("A clean copied response");
		const sleep = vi.fn(() => Promise.resolve());

		await expect(
			captureClipboardHandback({
				triggerCopy,
				readClipboard,
				sleep,
				attempts: 3,
				delayMs: 0,
			}),
		).resolves.toBe("A clean copied response");

		expect(triggerCopy).toHaveBeenCalledTimes(1);
	});

	it("falls back to null when clipboard never changes", async () => {
		const triggerCopy = vi.fn();
		const readClipboard = vi.fn<() => Promise<string>>().mockResolvedValue("before");
		const sleep = vi.fn(() => Promise.resolve());

		await expect(
			captureClipboardHandback({
				triggerCopy,
				readClipboard,
				sleep,
				attempts: 2,
				delayMs: 0,
			}),
		).resolves.toBeNull();
	});
});
