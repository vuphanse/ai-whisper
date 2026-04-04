import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginBrokerReply,
	endBrokerReply,
} from "../packages/shared/src/index.ts";
import { createCodexLiveSession } from "../packages/adapter-codex/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

describe("codex live session", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("submits broker work with an explicit submit keystroke", async () => {
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
		});

		expect(writes).toHaveLength(2);
		expect(writes[0]).toContain("Return ONLY valid JSON.");
		expect(writes[1]).toBe("\r");

		fakePty.emitData(
			`${beginBrokerReply("work_codex_submit")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_codex_submit")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("retries with bracketed paste if no framed reply starts", async () => {
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
		});

		await vi.advanceTimersByTimeAsync(1_500);

		expect(writes[2]).toContain("\u001b[200~");
		expect(writes[2]).toContain("Return ONLY valid JSON.");
		expect(writes[2]).toContain("\u001b[201~");
		expect(writes[3]).toBe("\r");

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
		});

		fakePty.emitData(`${beginBrokerReply("work_codex_no_retry")}\n`);
		await vi.advanceTimersByTimeAsync(1_500);

		expect(writes).toHaveLength(2);

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

	it("forwards terminal escape responses while broker work is pending", async () => {
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
		});

		session.writeUserInput("\u001b[1;1R");
		session.writeUserInput("x");

		expect(writes).toContain("\u001b[1;1R");
		expect(writes).not.toContain("x");

		fakePty.emitData(
			`${beginBrokerReply("work_codex_terminal")}\n{"kind":"answer","content":"terminal","transitionIntent":"completed"}\n${endBrokerReply("work_codex_terminal")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "terminal",
			transitionIntent: "completed",
		});
	});
});
