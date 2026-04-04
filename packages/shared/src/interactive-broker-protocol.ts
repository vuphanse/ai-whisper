export type InteractiveBrokerFrameState = {
	insideFrame: boolean;
	buffer: string;
	textBuffer?: string;
};

const BEGIN_PREFIX = "AI_WHISPER_REPLY_BEGIN:";
const END_PREFIX = "AI_WHISPER_REPLY_END:";

export function beginBrokerReply(workItemId: string) {
	return `${BEGIN_PREFIX}${workItemId}`;
}

export function endBrokerReply(workItemId: string) {
	return `${END_PREFIX}${workItemId}`;
}

function stripAnsi(input: string) {
	return input
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\r/g, "");
}

function isMarkerLine(
	line: string,
	input: { prefix: typeof BEGIN_PREFIX | typeof END_PREFIX },
) {
	const trimmed = line.trim();
	if (!trimmed.startsWith(input.prefix)) {
		return false;
	}

	const suffix = trimmed.slice(input.prefix.length);
	return suffix.length > 0 && !/\s/.test(suffix);
}

export function appendInteractiveBrokerChunk(
	state: InteractiveBrokerFrameState,
	chunk: string,
) {
	let next = { ...state, textBuffer: state.textBuffer ?? "" };
	let completedFrame: string | null = null;
	const text = `${next.textBuffer}${stripAnsi(chunk)}`;
	const lines = text.split("\n");
	const trailingLine = lines.pop() ?? "";

	for (const line of lines) {
		if (!next.insideFrame) {
			if (isMarkerLine(line, { prefix: BEGIN_PREFIX })) {
				next = {
					insideFrame: true,
					buffer: "",
					textBuffer: "",
				};
			}
			continue;
		}

		if (isMarkerLine(line, { prefix: END_PREFIX })) {
			completedFrame = next.buffer.trim();
			next = {
				insideFrame: false,
				buffer: "",
				textBuffer: "",
			};
			continue;
		}

		next.buffer += `${line}\n`;
	}

	next.textBuffer = trailingLine;

	if (next.insideFrame && isMarkerLine(trailingLine, { prefix: END_PREFIX })) {
		completedFrame = next.buffer.trim();
		next = {
			insideFrame: false,
			buffer: "",
			textBuffer: "",
		};
	}

	return {
		state: {
			insideFrame: next.insideFrame,
			buffer: next.buffer,
			textBuffer: next.textBuffer ?? "",
		},
		completedFrame,
	};
}
