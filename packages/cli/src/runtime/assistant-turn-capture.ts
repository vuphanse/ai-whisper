export function createAssistantTurnCapture() {
	const ansiCsiPattern = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, "g");
	let current = "";
	let latestCompleted: string | null = null;
	let streaming = false;

	function normalizeCapturedOutput(raw: string): string | null {
		// Normalize CRLF first (PTY onlcr converts \n -> \r\n in the data stream).
		let cleaned = raw.replace(/\r\n/g, "\n");
		// Strip CSI escape sequences.
		cleaned = cleaned.replace(ansiCsiPattern, "");
		// Simulate bare \r overwrite: keep only the last \r-separated segment per line.
		cleaned = cleaned
			.split("\n")
			.map((line) => {
				const parts = line.split("\r");
				return parts[parts.length - 1] ?? "";
			})
			.join("\n")
			.trim();
		return cleaned.length > 0 ? cleaned : null;
	}

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
			latestCompleted = normalizeCapturedOutput(current);
			current = "";
			streaming = false;
		},
		hasVisibleAssistantTurn() {
			return normalizeCapturedOutput(current) !== null || latestCompleted !== null;
		},
		extractLatestAssistantTurn() {
			if (streaming || !latestCompleted) {
				return { confidence: "low" as const, text: null };
			}
			return { confidence: "high" as const, text: latestCompleted };
		},
	};
}
