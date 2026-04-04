import { describe, it, expect, vi } from "vitest";
import { createCodexLiveSession } from "../packages/adapter-codex/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

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

describe("codex live session", () => {
	it("can be instantiated without errors", () => {
		const stdout = createFakeStdout();
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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

		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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

		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});

		await session.start();
		session.writeUserInput("hello");

		expect(fakePty.writes).toContain("hello");
	});

	it("stop() kills the PTY", async () => {
		const stdout = createFakeStdout();
		const fakePty = createFakePty();
		const killSpy = vi.spyOn(fakePty, "kill");

		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty: () => fakePty,
		});

		await session.start();
		await session.stop();

		expect(killSpy).toHaveBeenCalledOnce();
	});
});
