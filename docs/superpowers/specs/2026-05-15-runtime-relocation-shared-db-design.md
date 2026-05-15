# Runtime Relocation & Shared SQLite — Design Spec

**Status:** draft
**Date:** 2026-05-15
**Author:** vuphan
**Depends on:** Phase 2 evaluator telemetry (merged at `58009fc`); the spec-driven-development rename (merged at `4a7dcdd`).
**Unblocks:** TUI dashboard for cross-collab monitoring (separate, future spec).

## Problem

Today every collab writes its runtime state into `<workspace>/.ai-whisper/runtime/` — both the `current-collab.json` state file and the `broker.sqlite` database. This is wrong for three reasons:

1. **Workspace pollution.** The `.ai-whisper/` directory lives inside the git workspace. It must be `.gitignore`d in every project that uses ai-whisper, and it muddles the workspace's git state. The runtime layer shouldn't be visible at the project level at all.
2. **No cross-collab discovery.** The state file is per-workspace. The CLI has no way to enumerate every active collab on the machine, which blocks any UI that watches multiple collabs at once (planned TUI dashboard).
3. **Manual port allocation.** `whisper collab start --port` requires the user to remember unique ports across parallel projects. Two collabs racing on the same port collide on bind.

This spec covers a single coordinated change: move all runtime state out of the workspace into a per-user directory at `~/.ai-whisper/`, share one SQLite file across every collab, and replace the JSON state file with normalised registry tables that the dashboard can later query directly.

## Goals

- Eliminate `<workspace>/.ai-whisper/` entirely. Nothing about ai-whisper appears inside any git workspace after this change.
- Every collab on the machine is enumerable from a single SQLite database.
- Each `whisper collab start` allocates a free port automatically (with `--port` override).
- Each git worktree gets its own collab; worktrees of the same repo are independent first-class workspaces.
- All existing functionality — `start`, `stop`, `recover`, `inspect`, `tell`, `mount`, `reconnect`, `status`, `relay-monitor` — continues to behave identically from the user's perspective, including the implicit cwd→collab resolution they rely on today.
- The change unblocks the TUI dashboard work without baking dashboard-specific concerns into this spec.

## Non-goals

- **No user migration tooling.** ai-whisper has no users beyond the author. Old `<workspace>/.ai-whisper/` directories from the previous layout will be ignored by the new code; the user resets state manually (`rm -rf <workspace>/.ai-whisper ~/.ai-whisper`) between iterations during dev.
- **No process-model change.** Each collab still runs its own broker daemon process on its own port. Only the SQLite file is shared. No "master daemon" or process consolidation is in scope.
- **No multi-user / multi-machine support.** Single user, single host. `~/.ai-whisper/` is per-user; SSH or network filesystems are not targets.
- **No `whisper collab purge` command.** Stopped collabs persist until manual cleanup; a future spec can add purge.
- **No TUI dashboard.** This spec only delivers the data layer the dashboard will consume.
- **No move-detection.** If the user `mv`s a workspace directory, the registry treats the new path as a new workspace. Documented; not solved here.

## Design

### Runtime layout

```
~/.ai-whisper/
  state.db                   shared SQLite, WAL mode
  state.db-wal               WAL sidecar
  state.db-shm               WAL shared memory
  daemons/<collab-id>.log    per-daemon stdout/stderr
```

`<workspace>/.ai-whisper/` is deleted from the codebase: no helper writes to it, no CLI command reads from it.

A new helper `getStateRoot()` in `packages/cli/src/runtime/paths.ts` resolves the root:

```ts
export function getStateRoot(): string {
  return process.env.AI_WHISPER_STATE_ROOT
      ?? path.join(os.homedir(), ".ai-whisper");
}
export function getSharedSqlitePath(): string {
  return path.join(getStateRoot(), "state.db");
}
```

`AI_WHISPER_STATE_ROOT` exists for tests (each test sets it to a temp directory) and as an escape hatch for advanced users. The CLI does not document it as a stable feature.

Cross-platform: `~/.ai-whisper/` is fine for macOS and Linux — the only supported targets. XDG state-dir compliance (`~/.local/state/ai-whisper/`) can be a later concern if Linux users complain.

### Schema

Schema version is tracked with `PRAGMA user_version`. The existing `broker_state` singleton table at `packages/broker/src/storage/apply-migrations.ts:4` is **not dropped** — keeping it preserves the `/status` endpoint contract at `packages/broker/src/runtime/create-broker-runtime.ts:65` (`getBrokerState(db).migrated`). Future schema authority is `user_version`; `broker_state` becomes a shadow row whose `schema_version` and `migrated` fields are written on each startup but never read except for backward compatibility. A later spec can retire it.

The existing `collab` table at `packages/broker/src/storage/apply-migrations.ts:10` already has `collab_id TEXT PRIMARY KEY`, `status TEXT NOT NULL`, `created_at`, `updated_at` columns. The shared contract at `packages/shared/src/literals.ts:21` defines `collabStates = ["active", "stopped"]` and `collabSchema` at `packages/shared/src/collab.ts:11` validates against it. This spec reuses the existing `'stopped'` value (no `'ended'` term, no enum change). New columns are additive only.

Four new tables plus column additions to the existing `collab` table:

```sql
-- new
CREATE TABLE workspace (
  id              TEXT PRIMARY KEY,        -- sha256(realpath(root)).slice(0,16)
  workspace_root  TEXT NOT NULL UNIQUE,    -- canonical absolute path, for display
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

-- altered (existing table; status column already exists, not re-added)
ALTER TABLE collab ADD COLUMN workspace_id  TEXT REFERENCES workspace(id);
ALTER TABLE collab ADD COLUMN stopped_at    TEXT;
ALTER TABLE collab ADD COLUMN launch_mode   TEXT;     -- 'tmux' | 'terminals' | 'none'
ALTER TABLE collab ADD COLUMN tmux_session  TEXT;
CREATE INDEX collab_by_workspace ON collab(workspace_id, status);

-- new
CREATE TABLE broker_daemon (
  collab_id          TEXT PRIMARY KEY REFERENCES collab(collab_id) ON DELETE CASCADE,
  host               TEXT NOT NULL,
  port               INTEGER NOT NULL,
  pid                INTEGER,                  -- NULL during pre-spawn reservation phase
  pid_start_time     TEXT,                     -- NULL until daemon writes it
  started_at         TEXT NOT NULL,
  last_heartbeat_at  TEXT NOT NULL             -- seeded at row creation, then daemon-maintained
);
CREATE UNIQUE INDEX broker_daemon_port ON broker_daemon(port);

-- new
CREATE TABLE session_attachment (
  collab_id        TEXT NOT NULL REFERENCES collab(collab_id) ON DELETE CASCADE,
  agent_type       TEXT NOT NULL,        -- 'codex' | 'claude'
  attachment_kind  TEXT NOT NULL,        -- 'owned' | 'adopted' | 'mounted'
  session_id       TEXT,
  provider_id      TEXT,
  launch_mode      TEXT,                 -- 'tmux' | 'terminals' (owned only)
  tty_path         TEXT,                 -- adopted | mounted
  pid              INTEGER,
  window_label     TEXT,
  attached_at      TEXT NOT NULL,
  PRIMARY KEY (collab_id, agent_type, attachment_kind)
);

-- new
CREATE TABLE recovery_state (
  collab_id            TEXT PRIMARY KEY REFERENCES collab(collab_id) ON DELETE CASCADE,
  state                TEXT NOT NULL,    -- 'normal' | 'recovery_required' | 'recovered'
  idle_after_recovery  INTEGER NOT NULL, -- 0 / 1
  recovered_at         TEXT
);
```

Three design choices worth flagging:

1. **`workspace.id` is a 16-char prefix of `sha256(realpath(root))`.** The canonical path is stored separately for display; the hash is the join key. Fixed-length, filename-safe (useful for `daemons/<collab-id>.log` style derived names), and computing the hash forces canonicalisation discipline at every callsite.
2. **"One active daemon per workspace" is enforced at the application layer, not as a SQL constraint.** A partial index can't subquery the `collab` table. Inside the `BEGIN IMMEDIATE` transaction in `start`, the code runs `SELECT 1 FROM collab WHERE workspace_id=? AND status='active'`; if any row matches, the start fails with `CollabAlreadyExistsForWorkspace`.
3. **`session_attachment` PK is `(collab_id, agent_type, attachment_kind)`.** Looser than `(collab_id, agent_type)` because today's state file allows a session to be owned first and later mounted (two rows). Preserving that history is cheap.
4. **`broker_daemon.pid` is nullable during the spawn reservation phase.** The parent CLI cannot know the child PID until after `spawn()` returns, but it must reserve the port atomically with the active-daemon check. The row is inserted with `pid = NULL, pid_start_time = NULL`; the daemon child writes both fields itself after it binds the port (it knows its own `process.pid`). A row with `pid IS NULL` means "reservation in progress" — `resolveCollab` returns `daemon: null` for such rows, and the stale sweep treats them like any other stale row once `last_heartbeat_at` passes the threshold (so a crashed-before-bind daemon is cleaned up by the normal sweep, no special path needed).

### Lifecycle

**`whisper collab start`** runs the following inside a single `BEGIN IMMEDIATE` transaction on the shared DB:

1. `workspaceId = sha256(realpath(cwd)).slice(0, 16)`.
2. Upsert `workspace` row (insert if missing, otherwise bump `last_seen_at`).
3. Reject with `CollabAlreadyExistsForWorkspace` if any `collab` row exists with `workspace_id = ?` and `status='active'`.
4. Allocate a port: if `--port` was given, validate it's free in both the OS (`isPortFree(p)`) and the registry (no row in `broker_daemon` with that port); otherwise iterate `[4500, 4999]` skipping ports already in `broker_daemon` and ports the OS reports as busy. Throw `NoFreePortAvailable` if exhausted.
5. Insert `collab` (status='active'), `broker_daemon` with `pid = NULL, pid_start_time = NULL, started_at = now, last_heartbeat_at = now`, and the initial `recovery_state` row.
6. Commit. Spawn the daemon process, passing it the allocated port and its own `collab_id` via env or argv.
7. Wait for the daemon's readiness probe (TCP connect + `GET /health` returning ok AND a DB read confirming `broker_daemon.pid IS NOT NULL` for this collab). Timeout: **30 s** (env-overridable as `AI_WHISPER_DAEMON_READY_TIMEOUT_MS`).
8. On readiness success: write any initial `session_attachment` rows. `start` exits 0.
9. On readiness failure (timeout, daemon process exited, port never bound, daemon never wrote its PID): run the cleanup transaction below, then exit non-zero with the underlying failure.

The daemon child, on startup, opens the shared DB and runs a single statement `UPDATE broker_daemon SET pid = ?, pid_start_time = ?, last_heartbeat_at = ? WHERE collab_id = ?` with its own `process.pid` and the platform's process-start-time read (`/proc/<pid>/stat` on Linux, `ps -o lstart` on macOS, or NULL where unreadable). It then starts the HTTP listener and the heartbeat thread. The parent's readiness probe succeeds only after this update lands, so by the time `start` returns 0 the registry's `broker_daemon` row is fully populated.

**Spawn / readiness failure cleanup.** The CLI parent process is responsible for cleaning up after a failed spawn — the daemon may not exist, so the stale-sweep can't help us in any reasonable time window. Cleanup runs in one `BEGIN IMMEDIATE`:

```sql
DELETE FROM broker_daemon WHERE collab_id = ?;
UPDATE collab SET status='stopped', stopped_at=?, updated_at=? WHERE collab_id = ?;
```

If the CLI parent itself is killed during the readiness wait, the `broker_daemon` row is orphaned. The stale-row sweep handles it within ~90 s once another daemon (in another collab) ticks its sweep timer — or, in the no-other-collab case, the next `start` attempt for that workspace fails fast with `CollabAlreadyExistsForWorkspace` and the user resolves it with explicit `stop`/`recover`.

**Heartbeat.** Each daemon runs a `setInterval` every **10 s** that `UPDATE broker_daemon SET last_heartbeat_at = now WHERE collab_id = ?`. Each daemon also runs a stale-row sweep every **60 s** (reusing the existing `diagnostics-sweep` timer infrastructure). For each `broker_daemon` row with `last_heartbeat_at` older than **90 s**:

- If `pid IS NULL`: orphan reservation from a `start` that never completed; delete the row, skip any PID check.
- Else, check process liveness with `process.kill(pid, 0)`. If it raises `ESRCH`, the process is gone — delete the row.
- If the process exists but `pid_start_time` differs from the row, treat as PID reuse — delete the row.
- If `pid` and `pid_start_time` both match a running process, the daemon is alive but its heartbeat thread has stalled — log a warning, leave the row.

All three cadences are env-overridable: `AI_WHISPER_HEARTBEAT_MS`, `AI_WHISPER_DAEMON_SWEEP_MS`, `AI_WHISPER_DAEMON_STALE_MS`.

**`whisper collab stop`** resolves the collab from cwd (or `--collab`), reads the `broker_daemon` row, then in one `BEGIN IMMEDIATE` deletes the `broker_daemon` row and sets `collab.status='stopped'` + `collab.stopped_at = now`. Commits. After commit: if the row carried `pid IS NOT NULL`, signal the daemon process (SIGTERM, then SIGKILL after a grace period); if `pid IS NULL` (orphan reservation case), there's no process to signal — the DB cleanup alone is the stop. `session_attachment` and `recovery_state` rows are kept for debugging; a future `purge` command can cascade-delete them.

**`whisper collab recover`** resolves the collab (must exist, `status='active'`). Inside `BEGIN IMMEDIATE`: if a `broker_daemon` row already exists for this `collab_id` AND it is live (`pid IS NOT NULL`, heartbeat within stale threshold, PID/pid_start_time still match a running process), throw `DaemonAlreadyRunning` — nothing to recover. Otherwise delete any existing `broker_daemon` row (whether orphan `pid IS NULL` reservation from a failed earlier `start`, or a dead row whose sweep hasn't fired yet), allocate a port (auto or `--port`), and insert a fresh row with `pid = NULL`. Commit, then follow the same spawn / readiness / pid-write / cleanup-on-failure flow as `start` (steps 6–9 above). The collab's identity, history, and session attachments are preserved.

### CLI command rewrites

A new helper `packages/cli/src/runtime/collab-resolver.ts` centralises the cwd→collab lookup so individual commands don't duplicate the logic:

```ts
export interface SessionAttachment {
  agentType: 'codex' | 'claude';
  attachmentKind: 'owned' | 'adopted' | 'mounted';
  sessionId: string | null;
  providerId: string | null;
  launchMode: 'tmux' | 'terminals' | null;
  ttyPath: string | null;
  pid: number | null;
  windowLabel: string | null;
  attachedAt: string;
}

export interface ResolvedCollab {
  collabId: string;
  workspaceId: string;
  workspaceRoot: string;
  daemon: { host: string; port: number; pid: number } | null;
  launch: { mode: 'tmux' | 'terminals' | 'none'; tmuxSession?: string };
  recovery: {
    state: 'normal' | 'recovery_required' | 'recovered';
    idleAfterRecovery: boolean;
    recoveredAt: string | null;
  };
  status: 'active' | 'stopped';
  attachments: SessionAttachment[];
}

export function resolveCollab(opts: {
  cwd: string;
  collabIdOverride?: string;
  requireActive?: boolean;
  requireDaemon?: boolean;
}): ResolvedCollab;
```

`resolveCollab` opens the shared DB read-only, derives `workspace_id` from `realpath(cwd)` (or uses the override), and runs the join across `collab × workspace × broker_daemon × recovery_state × session_attachment`. It returns one assembled record or throws a typed error: `NoCollabFoundForCwd`, `CollabAlreadyStopped`, `NoLiveDaemonForCollab`, `WorkspaceUnreadable`.

Every CLI command accepts `--collab <id>` as an override, forwarded to `resolveCollab`.

| Command | Before | After |
|---|---|---|
| `start` | Write state.json | Insert workspace + collab + broker_daemon (atomically), allocate port |
| `stop` | Read state.json, kill daemon, delete state.json | Resolve collab, soft-end, delete broker_daemon row, kill daemon |
| `recover` | Read state.json, re-spawn daemon, update state.json | Resolve collab (active, no daemon), insert new broker_daemon, update recovery_state |
| `inspect` | Read state.json, open broker | Resolve collab, open shared broker, render |
| `tell` | Read state.json, HTTP to daemon | Resolve collab (requireDaemon), HTTP to daemon |
| `mount` | Read+update state.json (mountedSessions) | Resolve collab, write `session_attachment(kind='mounted')` |
| `reconnect` | Read state.json, find mounted/adopted, reattach | Resolve collab, read session_attachment, reattach |
| `status` | Read state.json, summarise | Resolve collab, summarise from DB |
| `relay-monitor` | Read state.json | Resolve collab, open broker, watch relay_event |

The `state-file.ts` module is deleted entirely, including the v1–v5 migration logic that was only needed because the file persisted on disk between releases. The DB schema is now the only versioned shape, and migrations are forward-only-additive (see Error handling).

`recovery-guard.ts` (today reads state.json to detect daemons that died between commands) moves to checking `broker_daemon` row + PID liveness. Same flow, different data source.

The `createBrokerRuntime({ sqlitePath })` API is unchanged. Tests still pass their own temp sqlite paths. The CLI just resolves the production path differently.

### Error handling

**Race conditions.** Two `whisper collab start` invocations for the same workspace simultaneously: both enter `BEGIN IMMEDIATE`, the second one blocks until the first commits, the second's "no active collab" check fails, returns `CollabAlreadyExistsForWorkspace`. Two `start` calls in different workspaces serialize on the write lock (one waits for the other to commit) and the port allocator inside that transaction sees the first's port reservation, so the second call picks a distinct port.

**Schema-version skew across daemons.** Older daemon (schema v1) and newer daemon (v2) coexisting: v1 runs first, applies v1 DDL, sets `user_version=1`. v2 starts, sees `user_version=1 < 2`, applies v2 DDL, bumps to 2. v1 keeps working because all migrations are **additive only** — no `DROP COLUMN`, no `NOT NULL` without a default, no rename. Migration code is wrapped in `BEGIN EXCLUSIVE` so simultaneous-start migrations don't interleave.

**Stale daemons.** Handled by the sweep described above. PID-reuse is mitigated by cross-checking `pid_start_time`; platforms where that's unreadable (uncommon) fall back to PID-only and accept rare false positives.

**Path edge cases.** `realpath` failures throw `WorkspaceUnreadable` from `resolveCollab` (don't silently fall through to "no collab"). Running a CLI command from a subdirectory of a workspace produces a different `realpath` and thus a different `workspace_id` — looks like "no collab found." Workspaces are root-keyed; subdirectory lookups are out of scope for v1.

**Database errors.** `busy_timeout = 5000` retries normal contention. Persistent busy returns "database busy — try again." Corruption: open failure reports "database corrupted — reset with `rm ~/.ai-whisper/state.db`" and exits. Acceptable given the explicit no-migration stance.

**Port allocation.** Range `[4500, 4999]` exhausted: throw `NoFreePortAvailable` with the range in the error message. The small race between `osPortIsFree(p)` and the daemon's actual bind is accepted; bind failure surfaces as a daemon spawn failure (see below).

**Spawn / readiness failure.** Daemon spawn can fail for several reasons: the spawned process crashes immediately, the OS port bind race resolves against us, the daemon's startup code throws, the daemon never writes its PID, or the readiness probe times out (default 30 s, env-overridable). In all cases the CLI parent runs the cleanup transaction described in the Lifecycle section — delete `broker_daemon`, set `collab.status='stopped'`. If the CLI parent itself is killed during the readiness wait, the orphan `broker_daemon` row is reclaimed by the stale-row sweep — but only if another daemon (in another collab) is alive to run its sweep timer. In the solo case (no other active collabs on the machine), the orphan row persists; the user clears it by running `whisper collab stop` to mark the collab `'stopped'` and remove the row, then `start` again. `recover` will also accept and clear an orphan `pid IS NULL` row as part of its normal flow.

### Testing strategy

The shared-DB design keeps the test pattern that already works: each test creates a temp directory and sqlite path. The `AI_WHISPER_STATE_ROOT` env var is the lever — tests set it to a temp directory, all `getStateRoot()` resolutions land there, no test ever touches the user's real `~/.ai-whisper/`.

Coverage:

1. **`getStateRoot()` + workspace id.** Env var precedence; `workspaceIdFromPath(realpath)` determinism; symlink collapse; case-sensitivity behaviour on the host filesystem.
2. **Schema migrations.** Fresh DB lands at expected `user_version`; re-running is a no-op; concurrent migrations are serialised by `BEGIN EXCLUSIVE`.
3. **Repositories.** One focused test file per new table: workspace, broker_daemon, session_attachment, recovery_state. Insert / update / list / delete / edge cases.
4. **`resolveCollab`.** Cwd→workspace_id→active collab→assembled record; `--collab` override path; each typed error case; behaviour when some rows are missing (no daemon, no recovery_state, no attachments).
5. **Port allocator.** Picks first free port in range; skips registry-busy ports; respects OS rejection; throws on exhaustion.
6. **Lifecycle commands (integration).** `start` → registry row + live daemon. `start` twice in same workspace → error. `start` in two workspaces concurrently → distinct ports, both succeed. `start` with a daemon that fails readiness → cleanup runs, collab row is `'stopped'`, no orphan `broker_daemon` row. `stop` → status='stopped', daemon dead, port free. `recover` after kill -9 → new broker_daemon row, same collab_id, daemon back up. All commands accept `--collab`.
7. **Stale-daemon sweep.** Old heartbeat + dead PID → row deleted; old heartbeat + live PID with matching `pid_start_time` → warning, row kept; concurrent sweepers → idempotent.
8. **Cross-collab isolation.** With multiple collabs in the shared DB, every repo query filtered on `collab_id` returns only that collab's rows.
9. **End-to-end multi-collab.** Three temp workspaces, three concurrent collabs, inspect each, stop the middle one, verify the other two are untouched.

Tests intentionally not written:
- Migration from the old per-workspace state file (no migration path).
- Multi-user-on-same-machine (out of scope).
- DB corruption recovery (manual user action).
- NFS / network FS behaviour (unsupported).

**Test count estimate.** ~30–40 new tests across ~8 new files. ~13 existing CLI-command tests that today assert state-file shapes are rewritten to assert against DB rows instead — same coverage, different data source. The remaining ~578 tests should continue to pass unchanged because the broker DB shape change is additive and the CLI commands' externally observable behaviour is unchanged.

## Risks accepted

- **Single point of corruption.** `~/.ai-whisper/state.db` going bad takes every collab with it. Pre-release tool, single user, file-level backup is the user's responsibility.
- **Schema-version drift across CLI builds.** Only one CLI version is installed at a time in practice; not a real concern.
- **Workspace move not detected.** `mv project-a project-b` produces a new `workspace_id`; old workspace row becomes orphaned. Out of scope.
- **Sub-directory lookups fail.** Running CLI commands from a subdirectory of a workspace produces a different `realpath` and looks like "no collab found." Workspaces are root-keyed; defer.

## Open questions

None at write time. All design forks were settled in brainstorming.
