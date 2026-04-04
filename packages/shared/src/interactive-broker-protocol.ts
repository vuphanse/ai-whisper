export type InteractiveBrokerFrameState = {
	insideFrame: boolean;
	buffer: string;
};

export function beginBrokerReply(workItemId: string) {
	return `AI_WHISPER_REPLY_BEGIN:${workItemId}`;
}

export function endBrokerReply(workItemId: string) {
	return `AI_WHISPER_REPLY_END:${workItemId}`;
}

export function appendInteractiveBrokerChunk(
	state: InteractiveBrokerFrameState,
	chunk: string,
) {
	let next = { ...state };
	let completedFrame: string | null = null;

	for (const line of chunk.split("\n")) {
		if (!next.insideFrame && line.startsWith("AI_WHISPER_REPLY_BEGIN:")) {
			next = { insideFrame: true, buffer: "" };
			continue;
		}
		if (next.insideFrame && line.startsWith("AI_WHISPER_REPLY_END:")) {
			completedFrame = next.buffer.trim();
			next = { insideFrame: false, buffer: "" };
			continue;
		}
		if (next.insideFrame) {
			next.buffer += `${line}\n`;
		}
	}

	return { state: next, completedFrame };
}
