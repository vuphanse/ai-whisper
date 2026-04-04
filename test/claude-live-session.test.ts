import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginBrokerReply,
	endBrokerReply,
	type BrokerArtifactHandle,
} from "../packages/shared/src/index.ts";
import { createClaudeLiveSession } from "../packages/adapter-claude/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

const stubHandle: BrokerArtifactHandle = {
	workItemId: "stub",
	artifactDirPath: "/tmp/artifacts/stub",
	requestFilePath: "/tmp/artifacts/stub/request.json",
	statusFilePath: "/tmp/artifacts/stub/status.json",
};

describe("claude live session", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("submits broker work with plain text and carriage return", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const writes: string[] = [];
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return {
					...fakePty,
					write(data: string) {
						writes.push(data);
						fakePty.write(data);
					},
				};
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_claude_submit",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("AI_WHISPER_REPLY_BEGIN:work_claude_submit");
		expect(writes[0]).toContain(
			'Line 2: one compact JSON object like {"kind":"answer","content":"...","transitionIntent":"completed"}',
		);
		await vi.advanceTimersByTimeAsync(75);
		expect(writes).toHaveLength(2);
		expect(writes[1]).toBe("\r");
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_claude_submit")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_claude_submit")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("forwards terminal escape responses while broker work is pending", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const writes: string[] = [];
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return {
					...fakePty,
					write(data: string) {
						writes.push(data);
						fakePty.write(data);
					},
				};
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_claude_terminal",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		session.writeUserInput("\u001b[1;1R");
		session.writeUserInput("x");

		expect(writes).toContain("\u001b[1;1R");
		expect(writes).not.toContain("x");
		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_claude_terminal")}\n{"kind":"answer","content":"terminal","transitionIntent":"completed"}\n${endBrokerReply("work_claude_terminal")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "terminal",
			transitionIntent: "completed",
		});
	});

	it("ignores echoed prompt markers before frame parsing is armed", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_claude_echo",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		fakePty.emitData(`${beginBrokerReply("work_claude_echo")}\n`);
		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_claude_echo")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_claude_echo")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});
});
