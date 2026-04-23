type RelayDecision =
	| { kind: "passthrough"; data: string }
	| { kind: "relay"; line: string }
	| { kind: "error"; message: string }
	| { kind: "buffering"; line: string };

function isBackspace(char: string): boolean {
	return char === "\u0008" || char === "\u007f";
}

export function createRelayLineBuffer(input: {
	getError: (line: string) => string | null;
	isRelayDirective: (line: string) => boolean;
	isRelayPrefix: (line: string) => boolean;
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
					: input.isRelayDirective(completed)
						? { kind: "relay", line: completed }
						: { kind: "passthrough", data: `${completed}${terminator}` },
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
			// Accumulate consecutive plain chars so that multi-byte sequences
			// (e.g. ESC[A arrow keys) land on the downstream PTY as a single
			// write instead of being split byte-by-byte — otherwise a bare
			// ESC can reach the child's line editor before its follow-up
			// bytes arrive.
			let passthroughRun = "";
			const flushPassthroughRun = () => {
				if (passthroughRun.length > 0) {
					results.push({ kind: "passthrough", data: passthroughRun });
					passthroughRun = "";
				}
			};

			for (const char of chunk) {
				if (char === "\r") {
					flushPassthroughRun();
					skipNextLineFeed = true;
					flushLine(results, "\r");
					continue;
				}

				if (char === "\n") {
					if (skipNextLineFeed) {
						skipNextLineFeed = false;
						continue;
					}

					flushPassthroughRun();
					flushLine(results, "\n");
					continue;
				}

				skipNextLineFeed = false;

				if (isBackspace(char)) {
					if (relayCandidate || line.length > 0) {
						flushPassthroughRun();
						line = line.slice(0, -1);
						if (relayCandidate) {
							if (line.startsWith("@@")) {
								results.push({ kind: "buffering", line });
								continue;
							}

							relayCandidate = false;
							if (line.length > 0) {
								results.push({ kind: "passthrough", data: line });
								line = "";
							}
							continue;
						}
					}

					passthroughRun += char;
					continue;
				}

				// Plain char outside any relay-candidate context: extend the run.
				if (!relayCandidate && line.length === 0 && char !== "@") {
					passthroughRun += char;
					continue;
				}

				flushPassthroughRun();
				line += char;
				if (!relayCandidate && line === "@") {
					results.push({ kind: "buffering", line });
					continue;
				}

				if (!relayCandidate && line === "@@") {
					relayCandidate = true;
					results.push({ kind: "buffering", line });
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

				if (relayCandidate && input.isRelayPrefix(line)) {
					results.push({ kind: "buffering", line });
					continue;
				}

				results.push({ kind: "buffering", line });
			}

			flushPassthroughRun();
			return results;
		},
	};
}
