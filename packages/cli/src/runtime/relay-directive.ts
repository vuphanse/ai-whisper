import {
	relayDirectiveSchema,
	type RelayDirective,
} from "@ai-whisper/shared";

const relayPattern =
	/^@@(?<target>codex|claude)(?<force>\[new\])?\s+(?<instruction>.+)$/;
const unsupportedRelayPrefix = /^@@(?<target>codex|claude)\[/;

export function parseRelayDirective(raw: string): RelayDirective | null {
	const trimmed = raw.trim();
	const match = relayPattern.exec(trimmed);

	const groups = match?.groups;
	if (!groups?.target || !groups.instruction) {
		return null;
	}

	return relayDirectiveSchema.parse({
		raw: trimmed,
		target: groups.target,
		forceNewThread: Boolean(groups.force),
		instruction: groups.instruction.trim(),
	});
}

export function getRelayDirectiveError(raw: string): string | null {
	const trimmed = raw.trim();
	if (unsupportedRelayPrefix.test(trimmed)) {
		return "[ai-whisper] Unsupported relay syntax. Phase 6 supports only @@codex ..., @@claude ..., and [new].";
	}
	return null;
}
