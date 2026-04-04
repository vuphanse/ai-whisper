import type { BrokerRuntime } from "@ai-whisper/broker";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReply(input: {
	broker: BrokerRuntime;
	threadId: string;
	workItemId: string;
	timeoutMs?: number;
}) {
	const timeoutAt = Date.now() + (input.timeoutMs ?? 15_000);

	while (Date.now() < timeoutAt) {
		const reply = input.broker.control
			.listReplies(input.threadId)
			.find((candidate) => candidate.workItemId === input.workItemId);

		if (reply) {
			return reply;
		}

		const workItem = input.broker.control.getWorkItem(input.workItemId);
		if (workItem?.deliveryState === "failed") {
			throw new Error(
				`Work item ${input.workItemId} failed without a reply payload.`,
			);
		}

		await sleep(50);
	}

	throw new Error(
		`Timed out waiting for reply to work item ${input.workItemId}.`,
	);
}
