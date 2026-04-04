import { describe, expect, it } from "vitest";
import {
	appendInteractiveBrokerChunk,
	beginBrokerReply,
	endBrokerReply,
} from "../packages/shared/src/interactive-broker-protocol.ts";

describe("live session protocol", () => {
	it("extracts framed broker-work replies only between explicit markers", () => {
		let state = { insideFrame: false, buffer: "" };

		state = appendInteractiveBrokerChunk(state, "ordinary interactive output\n").state;

		const opened = appendInteractiveBrokerChunk(
			state,
			`${beginBrokerReply("work_123")}\n`,
		);
		const middle = appendInteractiveBrokerChunk(
			opened.state,
			'{"kind":"answer","content":"ok","transitionIntent":"completed"}\n',
		);
		const closed = appendInteractiveBrokerChunk(
			middle.state,
			`${endBrokerReply("work_123")}\n`,
		);

		expect(closed.completedFrame).toContain('"kind":"answer"');
	});

	it("does not treat unframed braces as a broker-work reply", () => {
		const result = appendInteractiveBrokerChunk(
			{ insideFrame: false, buffer: "" },
			'normal output with {"brace":"noise"}\n',
		);

		expect(result.completedFrame).toBeNull();
	});
});
