export function createAssistantTurnCapture() {
	let current = "";
	let latestCompleted: string | null = null;
	let streaming = false;

	return {
		reset() {
			current = "";
			latestCompleted = null;
			streaming = false;
		},
		recordProviderOutput(chunk: string) {
			streaming = true;
			current += chunk;
		},
		finishAssistantTurn() {
			// Strip ANSI escape sequences.
			let cleaned = current.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
			// Simulate carriage-return overwrite: within each newline-delimited line,
			// a bare \r resets the visible content — keep only the last \r-separated segment.
			cleaned = cleaned
				.split("\n")
				.map((line) => {
					const parts = line.split("\r");
					return parts[parts.length - 1];
				})
				.join("\n")
				.trim();
			latestCompleted = cleaned.length > 0 ? cleaned : null;
			current = "";
			streaming = false;
		},
		extractLatestAssistantTurn() {
			if (streaming || !latestCompleted) {
				return { confidence: "low" as const, text: null };
			}
			return { confidence: "high" as const, text: latestCompleted };
		},
	};
}
