import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";

describe("mounted turn-owned relay", () => {
	it("swallows ordinary waiting-side input but allows Ctrl+C", async () => {
		const stdin = new PassThrough();
		const localMessages: string[] = [];
		const userInputs: string[] = [];

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) { userInputs.push(data); },
				sendLocalMessage(data: string) { localMessages.push(data); },
				onExit() {},
			},
			stdin,
			stdout: process.stdout,
			onRelay: async () => null,
			externalInputGate: {
				isBlocked: () => true,
				renderBlockedMessage: () => 'waiting for reply from claude (12s)',
				onCancel: vi.fn(),
			},
		});

		await runtime.start();
		stdin.write("hello");
		stdin.write("\u0003");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(userInputs).toEqual([]);
		expect(localMessages.join("")).toContain("waiting for reply from claude");
		expect(runtime).toBeTruthy();
	});
});
