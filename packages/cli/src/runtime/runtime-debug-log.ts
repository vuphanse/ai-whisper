import { appendFileSync } from "node:fs";

function toHex(text: string): string {
	return Buffer.from(text, "utf8").toString("hex");
}

export function createRuntimeDebugLogger(input: {
	logPath?: string | null;
	sessionId?: string | null;
}) {
	return (event: Record<string, unknown> & { data?: string }) => {
		if (!input.logPath) {
			return;
		}

		const payload =
			typeof event.data === "string"
				? {
						...event,
						dataHex: toHex(event.data),
					}
				: event;

		appendFileSync(
			input.logPath,
			`${JSON.stringify({
				at: new Date().toISOString(),
				sessionId: input.sessionId ?? null,
				...payload,
			})}\n`,
		);
	};
}
