import { describe, expect, it } from "vitest";
import { createAdoptedInteractiveSession } from "../packages/cli/src/runtime/adopted-interactive-session.ts";

describe("adopted interactive session", () => {
	it("writes user input and local messages to the adopted tty writer", async () => {
		const writes: string[] = [];
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write(data: string) {
					writes.push(data);
				},
				close() {},
				onData() {},
			}),
		});

		await session.start();
		session.writeUserInput("hello");
		session.sendLocalMessage("[ai-whisper] ack\n");

		expect(writes).toEqual(["hello", "[ai-whisper] ack\n"]);
	});

	it("stop closes the tty handle", async () => {
		let closed = false;
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write() {},
				close() {
					closed = true;
				},
				onData() {},
			}),
		});

		await session.start();
		await session.stop();

		expect(closed).toBe(true);
	});

	it("silently ignores writes before start", () => {
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write() {
					throw new Error("should not be called");
				},
				close() {},
				onData() {},
			}),
		});

		// No start() called — these should be no-ops
		expect(() => session.writeUserInput("hello")).not.toThrow();
		expect(() => session.sendLocalMessage("msg")).not.toThrow();
	});
});
