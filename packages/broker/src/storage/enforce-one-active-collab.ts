import type Database from "better-sqlite3";

export interface EnforceOptions {
	/**
	 * Liveness probe for a daemon pid. Defaults to the synchronous
	 * `process.kill(pid, 0)` check (ESRCH = dead, EPERM = alive), matching
	 * `defaultIsPidAlive` in the CLI mount command. Injected for deterministic
	 * tests that must not depend on real OS pids.
	 */
	isPidAlive?: (pid: number) => boolean;
	/** Warning sink. Defaults to console.error. Injected so tests can assert. */
	warn?: (message: string) => void;
}

interface ActiveRow {
	collab_id: string;
	workspace_id: string | null;
	created_at: string;
	pid: number | null;
	running_workflows: number;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process (dead). EPERM = exists but not signalable (alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Deduplicates pre-existing active collabs so that at most one active collab
 * exists per workspace_id. Survivor order: (a) owns a running workflow; else
 * (b) has a live daemon; else (c) newest by created_at. Non-survivors are
 * flipped to status='stopped' (never deleted). When two or more candidates own
 * a running workflow, none is auto-stopped (that is the orphaning failure we
 * are fixing): both stay active and a warning is emitted.
 *
 * Returns the list of workspace_ids that still have >1 active collab after the
 * pass (the irreducible conflicts), so the caller can decide whether the
 * partial unique index can be created.
 */
function dedupeActiveCollabs(
	db: Database.Database,
	opts: Required<Pick<EnforceOptions, "isPidAlive" | "warn">>,
): string[] {
	const rows = db
		.prepare(
			`SELECT c.collab_id, c.workspace_id, c.created_at, d.pid AS pid,
			        (SELECT COUNT(*) FROM workflows w
			           WHERE w.collab_id = c.collab_id AND w.status = 'running') AS running_workflows
			   FROM collab c
			   LEFT JOIN broker_daemon d ON d.collab_id = c.collab_id
			  WHERE c.status = 'active' AND c.workspace_id IS NOT NULL`,
		)
		.all() as ActiveRow[];

	const byWorkspace = new Map<string, ActiveRow[]>();
	for (const row of rows) {
		const key = row.workspace_id as string;
		const list = byWorkspace.get(key);
		if (list) list.push(row);
		else byWorkspace.set(key, [row]);
	}

	const conflicted: string[] = [];
	const now = new Date().toISOString();
	const stop = db.prepare(
		"UPDATE collab SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE collab_id = ?",
	);

	for (const [workspaceId, group] of byWorkspace) {
		if (group.length < 2) continue;

		const workflowOwners = group.filter((r) => r.running_workflows > 0);
		if (workflowOwners.length >= 2) {
			conflicted.push(workspaceId);
			opts.warn(
				`Workspace ${workspaceId} has ${workflowOwners.length} active collabs that each own a running workflow: ` +
					`${workflowOwners.map((r) => r.collab_id).join(", ")}. ` +
					"Refusing to auto-stop any (that would orphan a live run). " +
					"Stop the extra collab(s) manually with `whisper collab stop --collab <id>`. " +
					"The one-active-collab-per-workspace index will be created automatically once only one remains.",
			);
			continue;
		}

		let survivor: ActiveRow;
		if (workflowOwners.length === 1) {
			survivor = workflowOwners[0] as ActiveRow;
		} else {
			const live = group.filter((r) => r.pid !== null && opts.isPidAlive(r.pid));
			if (live.length >= 1) {
				survivor = live.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
			} else {
				survivor = group.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
			}
		}

		for (const row of group) {
			if (row.collab_id === survivor.collab_id) continue;
			stop.run(now, now, row.collab_id);
		}
	}

	return conflicted;
}

const CREATE_INDEX_SQL =
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_one_active_per_workspace " +
	"ON collab(workspace_id) WHERE status = 'active'";

/**
 * Returns the count of workspace_ids that still have more than one active
 * collab. The partial unique index is table-wide and all-or-nothing in SQLite:
 * it can only be created when this count is zero.
 */
function residualDuplicateCount(db: Database.Database): number {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM (
			   SELECT workspace_id FROM collab
			    WHERE status = 'active' AND workspace_id IS NOT NULL
			    GROUP BY workspace_id HAVING COUNT(*) > 1
			 )`,
		)
		.get() as { n: number };
	return row.n;
}

export function enforceOneActiveCollabPerWorkspace(
	db: Database.Database,
	options: EnforceOptions = {},
): void {
	const opts = {
		isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
		warn: options.warn ?? ((m: string) => console.error(m)),
	};
	const tx = db.transaction(() => {
		dedupeActiveCollabs(db, opts);
		if (residualDuplicateCount(db) === 0) {
			db.exec(CREATE_INDEX_SQL);
		} else {
			opts.warn(
				"Skipping idx_collab_one_active_per_workspace: an irreducible duplicate " +
					"active collab remains. The index will be created on a later startup " +
					"once only one active collab per workspace exists.",
			);
		}
	});
	tx();
}
