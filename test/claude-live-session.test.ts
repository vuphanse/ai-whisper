import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { createClaudeLiveSession } from "../packages/adapter-claude/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

function createFakeTtyStdout(cols: number, rows: number) {
	const emitter = new EventEmitter();
	const chunks: string[] = [];
	const stdout = {
		chunks,
		columns: cols,
		rows,
		write(data: string) {
			chunks.push(data);
			return true;
		},
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		removeListener: emitter.removeListener.bind(emitter),
		emit: emitter.emit.bind(emitter),
	};
	return stdout as unknown as NodeJS.WritableStream & {
		columns: number;
		rows: number;
		emit: (event: string) => boolean;
	};
}

function createFakeStdout() {
	const chunks: string[] = [];
	return {
		chunks,
		write(data: string) {
			chunks.push(data);
			return true;
		},
	} as unknown as NodeJS.WritableStream & { chunks: string[] };
}

describe("claude live session", () => {
	it("can be instantiated without errors", () => {
		const stdout = createFakeStdout();
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
		});

		expect(typeof session.start).toBe("function");
		expect(typeof session.stop).toBe("function");
		expect(typeof session.writeUserInput).toBe("function");
		expect(typeof session.sendLocalMessage).toBe("function");
	});

	it("start() attaches PTY and routes data to stdout", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});

		await session.start();
		fakePty.emitData("hello from pty");

		expect(stdout.chunks).toContain("hello from pty");
	});

	it("writeUserInput() forwards data to PTY", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});

		await session.start();
		session.writeUserInput("hello");

		expect(fakePty.writes).toContain("hello");
	});

	it("spawns the PTY at the real terminal size", async () => {
		const stdout = createFakeTtyStdout(200, 60);
		const fakePty = createFakePty();
		let spawned: { cols: number; rows: number } | null = null;

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: (i: { cols: number; rows: number }) => {
				spawned = { cols: i.cols, rows: i.rows };
				return fakePty;
			},
		});
		await session.start();

		expect(spawned).toEqual({ cols: 200, rows: 60 });
	});

	it("falls back to 120x40 when stdout has no size (non-tty)", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();
		let spawned: { cols: number; rows: number } | null = null;

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: (i: { cols: number; rows: number }) => {
				spawned = { cols: i.cols, rows: i.rows };
				return fakePty;
			},
		});
		await session.start();

		expect(spawned).toEqual({ cols: 120, rows: 40 });
	});

	it("resize() forwards to the PTY", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});
		await session.start();
		session.resize?.(150, 50);

		expect(fakePty.resizes).toContainEqual([150, 50]);
	});

	it("propagates stdout resize events to the PTY and stops on stop()", async () => {
		const stdout = createFakeTtyStdout(120, 40);
		const fakePty = createFakePty();
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});
		await session.start();

		stdout.columns = 90;
		stdout.rows = 30;
		stdout.emit("resize");
		expect(fakePty.resizes).toContainEqual([90, 30]);

		await session.stop();
		const before = fakePty.resizes.length;
		stdout.columns = 70;
		stdout.emit("resize");
		expect(fakePty.resizes.length).toBe(before);
	});

	it("stop() kills the PTY", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();
		const killSpy = vi.spyOn(fakePty, "kill");

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});

		await session.start();
		await session.stop();

		expect(killSpy).toHaveBeenCalledOnce();
	});
});
