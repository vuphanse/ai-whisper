const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const terminalResponsePatterns = [
	new RegExp(`${ESC}\\[[0-9;]*R`, "g"),
	new RegExp(`${ESC}\\[[?>0-9;]*c`, "g"),
	new RegExp(`${ESC}\\[\\?[0-9;:]*u`, "g"),
	new RegExp(`${ESC}\\[(?:I|O)`, "g"),
	new RegExp(`${ESC}\\[<[^${BEL}${ESC}]*[Mm]`, "g"),
	new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
];

const csiKeyboardSequencePattern = new RegExp(
	`${ESC}\\[(\\d+)(?::(\\d+))?(?:;(\\d+)(?::(\\d+))?)?u`,
	"g",
);

const MAX_RECENT_LITERAL_CHARS = 128;

export type NormalizedInputState = {
	recentLiteralChars?: string[];
};

function stripTerminalResponses(raw: string): string {
	return terminalResponsePatterns.reduce(
		(text, pattern) => text.replace(pattern, ""),
		raw,
	);
}

// Kitty keyboard progressive enhancement with REPORT_EVENT_TYPES: navigation
// keys (arrows, PgUp/PgDn, Home/End, F-keys, etc.) carry an event-type
// subparam — press=1, repeat=2, release=3 — e.g. `ESC[1;1:3A` for an up-arrow
// release. Downstream provider PTYs (codex, claude) only grok legacy arrows;
// the enhanced forms leak through as garbage and break navigation.
//
// Drop release events outright; strip the `:<event>` subparam from press/
// repeat so they reduce to the legacy xterm-style modifier form.
const csiNavigationWithEventTypePattern =
	// eslint-disable-next-line no-control-regex -- intentional: match CSI escape sequences
	/\x1b\[(\d+);(\d+):(\d+)([A-Z~])/g;

function stripKeyboardProgressiveEnhancement(raw: string): string {
	return raw.replace(
		csiNavigationWithEventTypePattern,
		(_match, p1, p2, eventType, terminator) =>
			eventType === "3" ? "" : `\x1b[${p1};${p2}${terminator}`,
	);
}

function decodePrintableCsiKeyboardSequence(
	primaryCodepointText: string,
	alternateCodepointText?: string,
	modifiersText?: string,
	eventTypeText?: string,
): { kind: "ignore" | "printable" | "control"; text: string } | null {

	const primaryCodepoint = Number(primaryCodepointText);
	const alternateCodepoint =
		alternateCodepointText !== undefined ? Number(alternateCodepointText) : null;
	const modifiers = modifiersText !== undefined ? Number(modifiersText) : 1;
	const decodedCodepoint = alternateCodepoint ?? primaryCodepoint;
	const modifierBits = Math.max(0, modifiers - 1);
	const hasCtrl = (modifierBits & 0b100) !== 0;

	if (!Number.isInteger(decodedCodepoint) || decodedCodepoint < 0) {
		return null;
	}

	if (hasCtrl) {
		const controlCodepoint = primaryCodepoint & 0x1f;
		if (controlCodepoint >= 0x00 && controlCodepoint <= 0x1f) {
			if (eventTypeText !== undefined) {
				return { kind: "ignore", text: "" };
			}
			return { kind: "control", text: String.fromCodePoint(controlCodepoint) };
		}
	}

	const isLineEditingControl =
		decodedCodepoint === 0x09 ||
		decodedCodepoint === 0x0d ||
		decodedCodepoint === 0x08 ||
		decodedCodepoint === 0x7f;
	if (isLineEditingControl && modifiers <= 4) {
		if (eventTypeText !== undefined) {
			return { kind: "ignore", text: "" };
		}
		try {
			return { kind: "control", text: String.fromCodePoint(decodedCodepoint) };
		} catch {
			return null;
		}
	}

	const isPrintable =
		decodedCodepoint >= 0x20 && decodedCodepoint !== 0x7f;
	if (isPrintable) {
		try {
			return { kind: "printable", text: String.fromCodePoint(decodedCodepoint) };
		} catch {
			return null;
		}
	}

	if (modifiers > 4) {
		return null;
	}

	return null;
}

function decodeCsiKeyboardInput(input: {
	raw: string;
	state: NormalizedInputState;
}): { text: string; state: NormalizedInputState } {
	let output = "";
	let lastIndex = 0;
	const recentLiteralChars = [...(input.state.recentLiteralChars ?? [])];

	function rememberLiteral(text: string) {
		for (const char of text) {
			const codepoint = char.codePointAt(0) ?? 0;
			if (codepoint >= 0x20 && codepoint !== 0x7f) {
				recentLiteralChars.push(char);
			}
		}
		if (recentLiteralChars.length > MAX_RECENT_LITERAL_CHARS) {
			recentLiteralChars.splice(0, recentLiteralChars.length - MAX_RECENT_LITERAL_CHARS);
		}
	}

	for (const match of input.raw.matchAll(csiKeyboardSequencePattern)) {
		const fullMatch = match[0];
		const index = match.index ?? 0;
		const literalChunk = input.raw.slice(lastIndex, index);
		output += literalChunk;
		rememberLiteral(literalChunk);

		const decoded = decodePrintableCsiKeyboardSequence(
			match[1] ?? "",
			match[2],
			match[3],
			match[4],
		);
		if (decoded === null) {
			output += fullMatch;
		} else if (decoded.kind === "control") {
			output += decoded.text;
		} else if (decoded.kind === "printable") {
			const recentIndex = recentLiteralChars.indexOf(decoded.text);
			if (recentIndex >= 0) {
				recentLiteralChars.splice(recentIndex, 1);
			} else {
				output += decoded.text;
				rememberLiteral(decoded.text);
			}
		}

		lastIndex = index + fullMatch.length;
	}

	const trailingLiteralChunk = input.raw.slice(lastIndex);
	output += trailingLiteralChunk;
	rememberLiteral(trailingLiteralChunk);
	return {
		text: output,
		state: {
			recentLiteralChars,
		},
	};
}

export function normalizeTerminalInput(input: {
	raw: string;
	state: NormalizedInputState;
}): { text: string; state: NormalizedInputState } {
	return decodeCsiKeyboardInput({
		raw: stripKeyboardProgressiveEnhancement(
			stripTerminalResponses(input.raw),
		),
		state: input.state,
	});
}
