import type Database from "better-sqlite3";

const LEASE_ID = 1;

/** Worst-case capture window (attempts × delayMs + trigger delay ≈ 1.3s today)
 *  plus headroom. A holder older than this is treated as crashed/stale. */
export const DEFAULT_LEASE_TTL_MS = 5000;

export interface LeaseOptions {
	/** Liveness probe; defaults to synchronous process.kill(pid, 0). */
	isPidAlive?: (pid: number) => boolean;
	/** Max hold before a lease is considered stale and reclaimable. */
	ttlMs?: number;
	/** Clock injection for deterministic tests. Returns epoch ms. */
	now?: () => number;
}

interface LeaseRow {
	holder_collab_id: string | null;
	holder_pid: number | null;
	acquired_at: string | null;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = dead. EPERM = alive but not signalable.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function resolveOptions(options: LeaseOptions): Required<LeaseOptions> {
	return {
		isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
		ttlMs: options.ttlMs ?? DEFAULT_LEASE_TTL_MS,
		now: options.now ?? Date.now,
	};
}

function isStale(row: LeaseRow, opts: Required<LeaseOptions>): boolean {
	if (row.holder_collab_id === null) return true; // free
	if (row.holder_pid === null || !opts.isPidAlive(row.holder_pid)) return true;
	if (row.acquired_at === null) return true;
	const age = opts.now() - Date.parse(row.acquired_at);
	return age > opts.ttlMs;
}

/**
 * Acquire the host-global capture lease for `collabId`/`pid`. Succeeds when the
 * lease is free or stale (dead holder pid, or acquired_at older than TTL). Runs
 * inside a single short write transaction — never held across the async capture.
 * Returns true on acquire, false when a live, within-TTL holder owns it.
 */
export function acquireCaptureLease(
	db: Database.Database,
	collabId: string,
	pid: number,
	options: LeaseOptions = {},
): boolean {
	const opts = resolveOptions(options);
	const tx = db.transaction((): boolean => {
		const row = db
			.prepare(
				"SELECT holder_collab_id, holder_pid, acquired_at FROM clipboard_capture_lease WHERE id = ?",
			)
			.get(LEASE_ID) as LeaseRow | undefined;

		if (row && !isStale(row, opts)) return false;

		const acquiredAt = new Date(opts.now()).toISOString();
		db.prepare(
			`INSERT INTO clipboard_capture_lease (id, holder_collab_id, holder_pid, acquired_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   holder_collab_id = excluded.holder_collab_id,
			   holder_pid       = excluded.holder_pid,
			   acquired_at      = excluded.acquired_at`,
		).run(LEASE_ID, collabId, pid, acquiredAt);
		return true;
	});
	return tx();
}

/** Release the lease iff `collabId` is the current holder. No-op otherwise. */
export function releaseCaptureLease(
	db: Database.Database,
	collabId: string,
): void {
	const tx = db.transaction(() => {
		db.prepare(
			"UPDATE clipboard_capture_lease SET holder_collab_id = NULL, holder_pid = NULL, acquired_at = NULL WHERE id = ? AND holder_collab_id = ?",
		).run(LEASE_ID, collabId);
	});
	tx();
}

/**
 * Startup sweep: clear the lease if its current holder is stale (dead pid or
 * TTL-exceeded). Idempotent; safe to run on every broker startup.
 */
export function sweepStaleCaptureLease(
	db: Database.Database,
	options: LeaseOptions = {},
): void {
	const opts = resolveOptions(options);
	const tx = db.transaction(() => {
		const row = db
			.prepare(
				"SELECT holder_collab_id, holder_pid, acquired_at FROM clipboard_capture_lease WHERE id = ?",
			)
			.get(LEASE_ID) as LeaseRow | undefined;
		if (!row || row.holder_collab_id === null) return;
		if (isStale(row, opts)) {
			db.prepare(
				"UPDATE clipboard_capture_lease SET holder_collab_id = NULL, holder_pid = NULL, acquired_at = NULL WHERE id = ?",
			).run(LEASE_ID);
		}
	});
	tx();
}
