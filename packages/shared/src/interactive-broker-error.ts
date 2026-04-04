export class InteractiveBrokerError extends Error {
	readonly code: "submit_failed" | "timed_out" | "invalid_reply";
	readonly outputTail?: string;

	constructor(
		code: "submit_failed" | "timed_out" | "invalid_reply",
		message: string,
		outputTail?: string,
	) {
		super(message);
		this.name = "InteractiveBrokerError";
		this.code = code;
		if (outputTail !== undefined) {
			this.outputTail = outputTail;
		}
	}
}
