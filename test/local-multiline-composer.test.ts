import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	createLocalModalConfirm,
	createLocalModalLineReader,
} from "../packages/cli/src/runtime/local-multiline-composer.ts";

describe("local modal line reader", () => {
	it("normalizes CSI-u keyboard reports while reading a modal line", async () => {
		const stdout = new PassThrough();
		const rendered: string[] = [];
		stdout.on("data", (chunk) => rendered.push(String(chunk)));

		const rawModeCalls: boolean[] = [];
		const stdin = new PassThrough() as PassThrough & {
			isTTY: boolean;
			isRaw: boolean;
			setRawMode(mode: boolean): void;
		};
		stdin.isTTY = true;
		stdin.isRaw = false;
		stdin.setRawMode = (mode: boolean) => {
			rawModeCalls.push(mode);
			stdin.isRaw = mode;
		};

		const reader = createLocalModalLineReader({
			stdin,
			stdout,
		});

		const linePromise = reader.readLine();
		stdin.write("/\u001b[47;1:3us\u001b[115;1:3uu\u001b[117;1:3ub\u001b[98;1:3um\u001b[109;1:3ui\u001b[105;1:3ut\u001b[116;1:3u\r");

		await expect(linePromise).resolves.toBe("/submit");
		reader.close();

		expect(rendered.join("")).toContain("/submit");
		expect(rendered.join("")).not.toContain("3u");
		expect(rawModeCalls).toEqual([true, false]);
	});

	it("confirms copied responses with Enter and cancels with Esc", async () => {
		const stdout = new PassThrough();
		const rendered: string[] = [];
		stdout.on("data", (chunk) => rendered.push(String(chunk)));

		const rawModeCalls: boolean[] = [];
		const stdin = new PassThrough() as PassThrough & {
			isTTY: boolean;
			isRaw: boolean;
			setRawMode(mode: boolean): void;
		};
		stdin.isTTY = true;
		stdin.isRaw = false;
		stdin.setRawMode = (mode: boolean) => {
			rawModeCalls.push(mode);
			stdin.isRaw = mode;
		};

		const confirm = createLocalModalConfirm({
			stdin,
			stdout,
			message: "[ai-whisper] Response copied, Enter to hand back or Esc to cancel.",
		});

		const confirmedPromise = confirm.run();
		stdin.write("\r");
		await expect(confirmedPromise).resolves.toBe(true);

		const cancelled = createLocalModalConfirm({
			stdin,
			stdout,
			message: "[ai-whisper] Response copied, Enter to hand back or Esc to cancel.",
		});

		const cancelledPromise = cancelled.run();
		stdin.write("\u001b");
		await expect(cancelledPromise).resolves.toBe(false);

		expect(rendered.join("")).toContain("Response copied, Enter to hand back or Esc to cancel.");
		expect(rendered.join("")).toContain("\r\u001b[2K");
		expect(rawModeCalls).toEqual([true, false, true, false]);
	});
});
