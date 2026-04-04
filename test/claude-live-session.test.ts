import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginBrokerReply,
	endBrokerReply,
} from "../packages/shared/src/index.ts";
import { createClaudeLiveSession } from "../packages/adapter-claude/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

describe("claude live session", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("submits broker work with bracketed paste and an explicit submit keystroke", async () => {
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
		});

		expect(writes).toHaveLength(2);
		expect(writes[0]).toContain("\u001b[200~");
		expect(writes[0]).toContain("Return ONLY valid JSON.");
		expect(writes[0]).toContain("\u001b[201~");
		expect(writes[1]).toBe("\r");

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
		});

		session.writeUserInput("\u001b[1;1R");
		session.writeUserInput("x");

		expect(writes).toContain("\u001b[1;1R");
		expect(writes).not.toContain("x");

		fakePty.emitData(
			`${beginBrokerReply("work_claude_terminal")}\n{"kind":"answer","content":"terminal","transitionIntent":"completed"}\n${endBrokerReply("work_claude_terminal")}\n`,
		);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "terminal",
			transitionIntent: "completed",
		});
	});
});
