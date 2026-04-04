import {
	mockProviderReplySchema,
	type ProviderReply,
} from "@ai-whisper/shared";

function extractJsonObjectCandidates(stdout: string): string[] {
	const candidates: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaping = false;

	for (let index = 0; index < stdout.length; index += 1) {
		const char = stdout[index];

		if (start !== -1 && inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (char === "\\") {
				escaping = true;
				continue;
			}
			if (char === "\"") {
				inString = false;
			}
			continue;
		}

		if (char === "{") {
			if (depth === 0) {
				start = index;
			}
			depth += 1;
			continue;
		}

		if (depth === 0) {
			continue;
		}

		if (char === "\"") {
			inString = true;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0 && start !== -1) {
				candidates.push(stdout.slice(start, index + 1));
				start = -1;
			}
		}
	}

	return candidates;
}

export function parseCodexOutput(stdout: string): ProviderReply {
	const trimmed = stdout.trim();
	const candidates = extractJsonObjectCandidates(trimmed);

	if (candidates.length === 0) {
		return {
			kind: "failure",
			content: "Provider output did not contain JSON",
			transitionIntent: "failed",
		};
	}

	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (candidate === undefined) {
			continue;
		}
		try {
			return mockProviderReplySchema.parse(JSON.parse(candidate));
		} catch {
			// keep looking for the last valid provider reply object
		}
	}

	return {
		kind: "failure",
		content: "Provider output contained invalid JSON",
		transitionIntent: "failed",
	};
}
