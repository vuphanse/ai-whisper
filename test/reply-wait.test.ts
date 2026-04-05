import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForReply } from "../packages/cli/src/runtime/reply-wait.ts";

describe("waitForReply", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits long enough for a late broker reply by default", async () => {
		vi.useFakeTimers();

		const reply = {
			replyId: "reply_1",
			threadId: "thread_1",
			collabId: "collab_1",
			workItemId: "work_1",
			sourceSessionId: "session_1",
			turnIndex: 1,
			kind: "answer" as const,
			content: "ok",
			transitionIntent: "completed" as const,
			artifactManifestIds: [],
			createdAt: "2026-04-05T09:29:00.858Z",
		};

		let replies: typeof reply[] = [];
		setTimeout(() => {
			replies = [reply];
		}, 45_000);

		const broker = {
			control: {
				listReplies() {
					return replies;
				},
				getWorkItem() {
					return {
						deliveryState: "delivered",
					};
				},
			},
		};

		const pending = waitForReply({
			broker: broker as never,
			threadId: "thread_1",
			workItemId: "work_1",
		});

		await vi.advanceTimersByTimeAsync(45_000);

		await expect(pending).resolves.toEqual(reply);
	});
});
