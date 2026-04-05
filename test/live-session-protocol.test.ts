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

	it("extracts framed replies from ANSI-decorated terminal output", () => {
		const state = { insideFrame: false, buffer: "" };

		const opened = appendInteractiveBrokerChunk(
			state,
			`\u001b[32m${beginBrokerReply("work_ansi")}\u001b[39m\r\n`,
		);
		const middle = appendInteractiveBrokerChunk(
			opened.state,
			"\u001b[2m{\"kind\":\"answer\",\"content\":\"ok\",\"transitionIntent\":\"completed\"}\u001b[22m\r\n",
		);
		const closed = appendInteractiveBrokerChunk(
			middle.state,
			`\u001b[33m${endBrokerReply("work_ansi")}\u001b[39m`,
		);

		expect(closed.completedFrame).toContain('"kind":"answer"');
	});

	it("extracts framed replies when markers are split across chunks", () => {
		const state = { insideFrame: false, buffer: "" };

		const first = appendInteractiveBrokerChunk(
			state,
			`${beginBrokerReply("work_split").slice(0, 18)}`,
		);
		const second = appendInteractiveBrokerChunk(
			first.state,
			`${beginBrokerReply("work_split").slice(18)}\n{"kind":"answer","content":"split","transitionIntent":"completed"}\n`,
		);
		const closed = appendInteractiveBrokerChunk(
			second.state,
			`${endBrokerReply("work_split")}`,
		);

		expect(closed.completedFrame).toContain('"content":"split"');
	});

	it("ignores marker text embedded inside ordinary echoed prompt lines", () => {
		const result = appendInteractiveBrokerChunk(
			{ insideFrame: false, buffer: "", textBuffer: "" },
			`Reply with exactly three lines. Line 1: ${beginBrokerReply("work_echo")} Line 2: {"kind":"answer"} Line 3: ${endBrokerReply("work_echo")}\n`,
		);

		expect(result.completedFrame).toBeNull();
		expect(result.state.insideFrame).toBe(false);
	});
});
