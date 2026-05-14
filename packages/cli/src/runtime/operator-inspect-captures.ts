import type { RelayCaptureDiagnosticRecord } from "@ai-whisper/broker";

const SAMPLE_VIEW_LEN = 60;

function formatScore(n: number | null): string {
	return n === null ? "-" : n.toFixed(2);
}

function truncate(text: string | null, max: number): string {
	if (text === null) return "-";
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function formatTime(iso: string): string {
	// Show HH:MM:SS portion only for compactness.
	const t = iso.slice(11, 19);
	return t.length === 8 ? t : iso;
}

export function formatCapturesView(input: {
	rows: RelayCaptureDiagnosticRecord[];
	collabId: string;
}): string {
	if (input.rows.length === 0) {
		return `No capture diagnostics for ${input.collabId}.\n`;
	}

	const header = [
		"CAPTURE TIME",
		"STATUS",
		"PROV",
		"CLIP",
		"TURN",
		"JACCARD",
		"CONTAIN",
		"HANDOFF",
		"RACE",
		"SAMPLE",
	];

	const lines: string[] = [];
	lines.push(header.join("  "));

	for (const row of input.rows) {
		lines.push(
			[
				formatTime(row.createdAt),
				row.captureStatus,
				row.targetProvider,
				String(row.clipLen),
				String(row.turnLen),
				formatScore(row.jaccardScore),
				formatScore(row.containmentScore),
				row.handoffId,
				row.abortedByRaceGuard ? "RACE" : "-",
				truncate(row.clipSample ?? row.turnSample, SAMPLE_VIEW_LEN),
			].join("  "),
		);
	}

	return `${lines.join("\n")}\n`;
}
