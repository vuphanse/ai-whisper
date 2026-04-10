import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLiveSessionRuntime } from "../packages/cli/src/runtime/live-session.ts";

function makeLiveSession(overrides?: {
	externalInputRouter?: { handleInput: (t: string) => boolean | Promise<boolean> };
	externalInputGate?: {
		isBlocked: () => boolean;
		renderBlockedMessage: () => string;
		onCancel: () => void;
	};
	onActivity?: () => void;
}) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const interactiveSession = {
		start: vi.fn(() => Promise.resolve()),
		stop: vi.fn(() => Promise.resolve()),
		sendLocalMessage: vi.fn(),
		writeUserInput: vi.fn(),
		onProviderOutput: vi.fn(),
		onExit: vi.fn(),
	};
	const session = createLiveSessionRuntime({
		interactiveSession: interactiveSession as never,
		stdin,
		stdout,
		onRelay: vi.fn(() => Promise.resolve(null)),
		...overrides,
	});
	return { session, stdin, interactiveSession };
}

describe("live-session onActivity", () => {
	it("calls onActivity when keystroke passes through to provider", async () => {
		const onActivity = vi.fn();
		const { session, stdin } = makeLiveSession({ onActivity });
		await session.start();
		stdin.push("x");
		await new Promise((r) => setImmediate(r));
		expect(onActivity).toHaveBeenCalledTimes(1);
		await session.stop();
	});

	it("does not call onActivity when keystroke consumed by externalInputRouter", async () => {
		const onActivity = vi.fn();
		const { session, stdin } = makeLiveSession({
			onActivity,
			externalInputRouter: { handleInput: () => true },
		});
		await session.start();
		stdin.push("a");
		await new Promise((r) => setImmediate(r));
		expect(onActivity).not.toHaveBeenCalled();
		await session.stop();
	});

	it("does not call onActivity when keystroke blocked by externalInputGate", async () => {
		const onActivity = vi.fn();
		const { session, stdin } = makeLiveSession({
			onActivity,
			externalInputGate: {
				isBlocked: () => true,
				renderBlockedMessage: () => "waiting",
				onCancel: () => {},
			},
		});
		await session.start();
		stdin.push("b");
		await new Promise((r) => setImmediate(r));
		expect(onActivity).not.toHaveBeenCalled();
		await session.stop();
	});
});

describe("live-session isPaused", () => {
	it("returns false normally and true inside withPausedInput", async () => {
		const { session } = makeLiveSession();
		await session.start();
		expect(session.isPaused()).toBe(false);
		let innerPaused = false;
		await session.withPausedInput(async () => {
			innerPaused = session.isPaused();
		});
		expect(innerPaused).toBe(true);
		expect(session.isPaused()).toBe(false);
		await session.stop();
	});
});
