import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFakePty } from "./helpers/fake-pty.ts";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";

describe("live session runtime", () => {
	it("forwards ordinary byte input to the host session without waiting for newline", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				runBrokerWork: () =>
					Promise.reject(
						new Error("broker work is not used in this test"),
					),
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("a");
		stdin.write("\u0003");

		expect(fakePty.writes.join("")).toContain("a");
		expect(fakePty.writes.join("")).toContain("\u0003");
	});

	it("consumes relay directives and writes local acknowledgement instead of forwarding them", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				runBrokerWork: () =>
					Promise.reject(
						new Error("broker work is not used in this test"),
					),
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.resolve(
					"[ai-whisper] Relayed to codex on active thread.\n",
				),
		});

		await runtime.start();
		stdin.write("@@codex review this plan\n");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakePty.writes.join("")).not.toContain(
			"@@codex review this plan",
		);
		expect(output.join("")).toContain("Relayed to codex");
	});

	it("rejects unsupported advanced relay syntax locally", async () => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const fakePty = createFakePty();
		const output: string[] = [];
		stdout.on("data", (chunk) => output.push(String(chunk)));

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput(data: string) {
					fakePty.write(data);
				},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				runBrokerWork: () =>
					Promise.reject(
						new Error("broker work is not used in this test"),
					),
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		stdin.write("@@codex[thread:thread_123] continue\n");

		expect(fakePty.writes.join("")).not.toContain("thread_123");
		expect(output.join("")).toContain("Unsupported relay syntax");
	});

	it("enables raw stdin mode while the live session is active", async () => {
		const stdout = new PassThrough();
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

		const runtime = createLiveSessionRuntime({
			interactiveSession: {
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput() {},
				sendLocalMessage(message: string) {
					stdout.write(message);
				},
				runBrokerWork: () =>
					Promise.reject(
						new Error("broker work is not used in this test"),
					),
			},
			stdin,
			stdout,
			onRelay: () =>
				Promise.reject(new Error("relay should not fire")),
		});

		await runtime.start();
		await runtime.stop();

		expect(rawModeCalls).toEqual([true, false]);
	});
});
