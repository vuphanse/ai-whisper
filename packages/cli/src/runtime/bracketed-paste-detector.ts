const ENABLE = "\x1b[?2004h"; // DECSET 2004 — codex enables bracketed paste
const RESET = "\x1b[?2004l"; // DECRST 2004 — codex disables it

export interface BracketedPasteDetector {
	/** Feed a chunk of provider PTY output. Tracks the latest paste-mode toggle. */
	observe(data: string): void;
	/** True when codex currently has bracketed-paste mode enabled. */
	readonly enabled: boolean;
}

/**
 * Observes codex PTY output for the bracketed-paste mode toggle. Codex emits
 * `ESC[?2004h` when its composer is active/ready (paste mode on) and `ESC[?2004l`
 * when not. `enabled` therefore doubles as a capability signal (does codex
 * support bracketed paste?) and a readiness signal (is the composer focused?).
 * If codex ever stops emitting the enable sequence, `enabled` stays false and
 * callers fall back to the keystream submit strategy — no code change required.
 */
export function createBracketedPasteDetector(): BracketedPasteDetector {
	let enabled = false;
	return {
		observe(data: string) {
			const hi = data.lastIndexOf(ENABLE);
			const lo = data.lastIndexOf(RESET);
			if (hi > lo) enabled = true;
			else if (lo > hi) enabled = false;
		},
		get enabled() {
			return enabled;
		},
	};
}
