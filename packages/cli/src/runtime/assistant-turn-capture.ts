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
			// Normalize CRLF first (PTY onlcr converts \n -> \r\n in the data stream).
			let cleaned = current.replace(/\r\n/g, "\n");
			// Strip CSI escape sequences.
			cleaned = cleaned.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
			// Simulate bare \r overwrite: keep only the last \r-separated segment per line.
			cleaned = cleaned
				.split("\n")
				.map((line) => {
					const parts = line.split("\r");
					return parts[parts.length - 1] ?? "";
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
