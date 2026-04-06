import { describe, expect, it, vi } from "vitest";
import { createBusyIndicator } from "../packages/cli/src/runtime/busy-indicator.ts";

describe("busy indicator", () => {
	it("renders notification and reports busy state", () => {
		const written: string[] = [];
		const indicator = createBusyIndicator({
			write: (data: string) => { written.push(data); },
		});

		expect(indicator.isBusy()).toBe(false);

		indicator.show({
			senderAgent: "claude",
			instruction: "review the implementation",
		});

		expect(indicator.isBusy()).toBe(true);
		expect(written.length).toBeGreaterThan(0);
		expect(written.some((w) => w.includes("Processing request from claude"))).toBe(true);
		expect(written.some((w) => w.includes("review the implementation"))).toBe(true);
	});

	it("clears notification on hide", () => {
		const written: string[] = [];
		const indicator = createBusyIndicator({
			write: (data: string) => { written.push(data); },
		});

		indicator.show({
			senderAgent: "claude",
			instruction: "review",
		});

		indicator.hide();

		expect(indicator.isBusy()).toBe(false);
		// Last write should contain CLEAR_LINE
		const lastWrite = written[written.length - 1];
		expect(lastWrite).toContain("\r\u001b[2K");
	});

	it("updates elapsed time on tick", () => {
		vi.useFakeTimers();
		const written: string[] = [];
		const indicator = createBusyIndicator({
			write: (data: string) => { written.push(data); },
		});

		indicator.show({
			senderAgent: "claude",
			instruction: "review",
		});

		const initialCount = written.length;
		vi.advanceTimersByTime(1000);

		expect(written.length).toBeGreaterThan(initialCount);
		expect(written[written.length - 1]).toContain("1s");

		indicator.hide();
		vi.useRealTimers();
	});

	it("hide is idempotent", () => {
		const written: string[] = [];
		const indicator = createBusyIndicator({
			write: (data: string) => { written.push(data); },
		});

		indicator.hide();
		indicator.hide();
		expect(indicator.isBusy()).toBe(false);
	});
});
