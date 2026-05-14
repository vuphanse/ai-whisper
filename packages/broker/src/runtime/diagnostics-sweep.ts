type ControlMethods = {
	sweepCaptureDiagnostics(input: { cutoffIso: string }): number;
};

export type DiagnosticsSweepDeps = {
	broker: { control: ControlMethods };
	/** Override the sweep interval in ms. Defaults to env or 1h. */
	intervalMs?: number;
	/** Override the retention window in days. Defaults to env or 30. */
	retentionDays?: number;
};

export type DiagnosticsSweep = {
	start(): void;
	stop(): void;
};

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_RETENTION_DAYS = 30;

function resolveIntervalMs(override: number | undefined): number {
	if (override !== undefined) return override;
	const envVal = process.env["AI_WHISPER_DIAGNOSTICS_SWEEP_MS"];
	if (envVal && Number.isFinite(Number(envVal))) return Number(envVal);
	return DEFAULT_INTERVAL_MS;
}

function resolveRetentionDays(override: number | undefined): number {
	if (override !== undefined) return override;
	const envVal = process.env["AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS"];
	if (envVal && Number.isFinite(Number(envVal))) return Number(envVal);
	return DEFAULT_RETENTION_DAYS;
}

export function createDiagnosticsSweep(deps: DiagnosticsSweepDeps): DiagnosticsSweep {
	const intervalMs = resolveIntervalMs(deps.intervalMs);
	const retentionDays = resolveRetentionDays(deps.retentionDays);
	let timer: ReturnType<typeof setInterval> | null = null;

	function tick(): void {
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
		deps.broker.control.sweepCaptureDiagnostics({ cutoffIso: cutoff.toISOString() });
	}

	return {
		start(): void {
			if (timer !== null) return;
			timer = setInterval(tick, intervalMs);
		},
		stop(): void {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
