type RelayDecision =
	| { kind: "passthrough"; data: string }
	| { kind: "relay"; line: string }
	| { kind: "error"; message: string }
	| { kind: "buffering" };

function isBackspace(char: string): boolean {
	return char === "\u0008" || char === "\u007f";
}

export function createRelayLineBuffer(input: {
	getError: (line: string) => string | null;
	isRelayCandidate: (line: string) => boolean;
}) {
	let line = "";
	let relayCandidate = false;
	let skipNextLineFeed = false;

	function flushLine(results: RelayDecision[], terminator: "\r" | "\n") {
		const completed = line;
		line = "";
		if (relayCandidate) {
			relayCandidate = false;
			const error = input.getError(completed);
			results.push(
				error
					? { kind: "error", message: error }
					: { kind: "relay", line: completed },
			);
			return;
		}

		results.push({
			kind: "passthrough",
			data: `${completed}${terminator}`,
		});
	}

	return {
		push(chunk: string): RelayDecision[] {
			const results: RelayDecision[] = [];

			for (const char of chunk) {
				if (char === "\r") {
					skipNextLineFeed = true;
					flushLine(results, "\r");
					continue;
				}

				if (char === "\n") {
					if (skipNextLineFeed) {
						skipNextLineFeed = false;
						continue;
					}

					flushLine(results, "\n");
					continue;
				}

				skipNextLineFeed = false;

				if (isBackspace(char)) {
					line = line.slice(0, -1);
					relayCandidate = line.startsWith("@@");
					results.push({ kind: "passthrough", data: char });
					continue;
				}

				line += char;
				if (!relayCandidate && line === "@") {
					results.push({ kind: "buffering" });
					continue;
				}

				if (!relayCandidate && line === "@@") {
					relayCandidate = true;
					results.push({ kind: "buffering" });
					continue;
				}

				if (!relayCandidate && !line.startsWith("@")) {
					results.push({ kind: "passthrough", data: line });
					line = "";
					continue;
				}

				if (!relayCandidate) {
					results.push({ kind: "passthrough", data: line });
					line = "";
					continue;
				}

				if (relayCandidate && !input.isRelayCandidate(line)) {
					results.push({ kind: "passthrough", data: line });
					line = "";
					relayCandidate = false;
					continue;
				}

				results.push({ kind: "buffering" });
			}

			return results;
		},
	};
}
