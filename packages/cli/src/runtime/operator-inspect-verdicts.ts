import type { RelayEvaluatorDiagnosticRecord } from "@ai-whisper/broker";

const REASON_MAX = 60;

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

function formatConf(n: number | null): string {
	return n === null ? "-" : n.toFixed(2);
}

function formatTokens(input: number | null, output: number | null): string {
	const i = input === null ? "-" : String(input);
	const o = output === null ? "-" : String(output);
	return `${i}/${o}`;
}

export function formatVerdictsView(input: {
	rows: RelayEvaluatorDiagnosticRecord[];
	collabId: string;
}): string {
	if (input.rows.length === 0) {
		return `No evaluator diagnostics for ${input.collabId}.\n`;
	}

	const header = [
		"TIME",
		"BRANCH",
		"PROVIDER",
		"ATTEMPT",
		"OUTCOME",
		"VERDICT",
		"CONF",
		"LAT(ms)",
		"TOK(in/out)",
		"HANDOFF",
		"REASON",
	];

	const lines: string[] = [];
	lines.push(header.join("  "));

	for (const row of input.rows) {
		lines.push(
			[
				formatTime(row.createdAt),
				row.evaluatorBranch,
				row.provider,
				row.attemptKind,
				row.outcome,
				row.verdict ?? "-",
				formatConf(row.confidence),
				String(row.latencyMs),
				formatTokens(row.inputTokens, row.outputTokens),
				row.handoffId,
				truncate(row.reason ?? row.errorMessage, REASON_MAX),
			].join("  "),
		);
	}

	return `${lines.join("\n")}\n`;
}
