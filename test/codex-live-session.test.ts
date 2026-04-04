import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginBrokerReply,
	endBrokerReply,
	InteractiveBrokerError,
	type BrokerArtifactHandle,
} from "../packages/shared/src/index.ts";
import { createCodexLiveSession } from "../packages/adapter-codex/src/index.ts";
import { buildCodexInteractiveBrokerPrompt } from "../packages/adapter-codex/src/codex-live-session-prompt.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

const stubHandle: BrokerArtifactHandle = {
	workItemId: "stub",
	artifactDirPath: "/tmp/artifacts/stub",
	requestFilePath: "/tmp/artifacts/stub/request.json",
	statusFilePath: "/tmp/artifacts/stub/status.json",
};

function expectedLinewiseWrites(
	prompt: string,
	input: { lineTerminator: "\r"; submitTerminator: "" | "\n" | "\r\n" },
) {
	const lines = prompt.split("\n");
	return lines.flatMap((line, index) =>
		index === lines.length - 1
			? input.submitTerminator === ""
				? [line]
				: [line, input.submitTerminator]
			: [line, input.lineTerminator],
	);
}

describe("codex live session", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("submits broker work with a plain newline submit", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const writes: string[] = [];
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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
			workItemId: "work_codex_submit",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		expect(writes).toEqual(
			expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "",
				},
			),
		);
		await vi.advanceTimersByTimeAsync(75);

		expect(writes).toEqual(
			expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "\n",
				},
			),
		);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_codex_submit")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_codex_submit")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("retries with carriage return if no framed reply starts", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const writes: string[] = [];
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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
			workItemId: "work_codex_retry",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(1_425);

		expect(writes).toEqual([
			...expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "\n",
				},
			),
			...expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "",
				},
			),
		]);
		await vi.advanceTimersByTimeAsync(75);

		expect(writes).toEqual([
			...expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "\n",
				},
			),
			...expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "\r\n",
				},
			),
		]);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_codex_retry")}\n{"kind":"answer","content":"retried","transitionIntent":"completed"}\n${endBrokerReply("work_codex_retry")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "retried",
			transitionIntent: "completed",
		});
	});

	it("does not retry after a framed reply has started", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const writes: string[] = [];
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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
			workItemId: "work_codex_no_retry",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(300);
		fakePty.emitData(`${beginBrokerReply("work_codex_no_retry")}\n`);
		await vi.advanceTimersByTimeAsync(1_125);

		expect(writes).toEqual(
			expectedLinewiseWrites(
				buildCodexInteractiveBrokerPrompt(stubHandle.requestFilePath, stubHandle.workItemId),
				{
					lineTerminator: "\r",
					submitTerminator: "\n",
				},
			),
		);

		fakePty.emitData(
			'{"kind":"answer","content":"streaming","transitionIntent":"completed"}\n',
		);
		fakePty.emitData(`${endBrokerReply("work_codex_no_retry")}\n`);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "streaming",
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
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_codex_echo",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		await vi.advanceTimersByTimeAsync(75);
		fakePty.emitData(`${beginBrokerReply("work_codex_echo")}\n`);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_codex_echo")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_codex_echo")}\n`,
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
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
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
			workItemId: "work_codex_terminal",
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
			`${beginBrokerReply("work_codex_terminal")}\n{"kind":"answer","content":"terminal","transitionIntent":"completed"}\n${endBrokerReply("work_codex_terminal")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "terminal",
			transitionIntent: "completed",
		});
	});

	it("rejects with InteractiveBrokerError timed_out when reply does not arrive", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_codex_timeout",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		const assertion = expect(replyPromise).rejects.toMatchObject({
			name: "InteractiveBrokerError",
			code: "timed_out",
		});
		await vi.advanceTimersByTimeAsync(15_000);
		await assertion;
	});

	it("rejects with InteractiveBrokerError invalid_reply when JSON is malformed", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;
		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});

		await session.start();
		const replyPromise = session.runBrokerWork({
			workItemId: "work_codex_invalid",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question",
			instruction: "Reply with valid JSON.",
		}, stubHandle);

		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_codex_invalid")}\nnot-valid-json\n${endBrokerReply("work_codex_invalid")}\n`,
		);

		await expect(replyPromise).rejects.toMatchObject({
			name: "InteractiveBrokerError",
			code: "invalid_reply",
		});
	});
});
