# Collab ↔ Workspace Binding Integrity — Design Spec

**Branch:** spec/collab-workspace-binding-integrity
**Status:** approved design, pre-plan
**Severity:** high — silently strands autonomous runs; the failure looks like a hang, not an error.

## Summary

A single workspace can accumulate **more than one `active` collab row**. When that
happens, collab resolution is ambiguous: a workflow can be created on (and bound to)
one collab while the live mounted agents and the running daemon belong to another. The
workflow's first handoff is created but never delivered or evaluated — the run sits
forever at its first step, while every operator-facing surface reports "healthy".

This spec **enforces one `active` collab per workspace** as an invariant. Mount
transparently **re-adopts** an existing active collab instead of creating a duplicate;
a partial unique index makes the invariant impossible to violate from any future code
path; and a migration resolves pre-existing duplicates before the index is created.

Scope is deliberately narrow: this is the **root-cause prevention** only. Two related
ideas considered during brainstorming were explicitly cut from this spec: smarter
resolution that prefers the live collab and warns on duplicates (a safety net that is
unnecessary once duplicates cannot form), and a fail-fast guard at `whisper workflow
start` (valuable, but a separate concern). They are recorded under
[Out of scope](#out-of-scope) so the decision is traceable.

## Symptom (observed)

A `complex-bug-fixing` workflow, triggered from a mounted claude session, never
progressed past **Phase 1 / Round 1 / step `implement`**:

- Dashboard: `turn: claude · waiting codex · handoff pending`, `health: Chain stuck`,
  `⚠ why: STUCK 5m22s — no progress and mount not alive`.
- `whisper collab inspect`: `Recovery: normal`, `Broker: ok`, **both** `codex` and
  `claude` `bound (healthy) [mounted]` with live ttys, `Turn owner: none`,
  `Handoff state: idle`, `Orchestrator: no`.
- `whisper collab status --json`: `status: active`, both agents `bound`,
  `recovery.state: normal`, `evaluator.status: ready`.

Every surface a normal operator checks reported **healthy**, yet the workflow did not
move. Two red herrings were ruled out before the real cause was found:

1. **"mount not alive"** suggested a dead PTY — but `inspect` showed both mounts live.
   The dashboard's `mountAlive` probe (`process.kill(mountedPid,0)` in `dashboard.ts`)
   keys off the *mounted-kind* attachment of the collab it is viewing; it reads false
   when that collab has no live mounted attachment, even though another collab for the
   same workspace does.
2. **"Orchestrator: no"** in `inspect` suggested the orchestrator was disabled — but
   `operator-inspect.ts` derives that line from `relay_turn_state.orchestratorEnabled`,
   which **defaults to `false` when the turn is idle** (`Active Thread: none`). The
   collab's `collab.orchestrator_enabled` was in fact `1` (corroborated by
   `evaluator.status: ready`, which `evaluator-config.ts` only returns when the
   orchestrator is enabled).

## Evidence (confirmed via `state.db`)

Direct queries against `~/.ai-whisper/state.db` proved the root cause:

```text
--- workflow's owning collab ---
wf_76cb8bef9621417b | collab_20260524231627309_744c11e7 | complex-bug-fixing | running | 0

--- the collab the operator was inspecting / agents mounted on ---
collab_20260524233022645_610d2c5f | orchestrator_enabled = 1

--- relay turn state for the inspected collab ---
(no row)                       # idle → inspect's "Orchestrator: no" default

--- latest handoff for the workflow ---
implement | claude | (no verdict) | 23:31:23   # created, never evaluated/delivered

--- daemon serving the inspected collab ---
pid 1912  ai-whisper/dist/bin/broker-daemon.js   # alive, version 0.2.0
```

The decisive fact: the workflow is bound to **`collab_…231627`** (created ~23:16), but
the live mounts and the daemon under inspection are **`collab_…233022`** (created
23:30) — **two `active` collabs for the same `workspace_root`
(`/Users/vu/Development/Favro`)**. The workflow's owning collab had no live daemon /
mounts to drive its handoff; the healthy collab owned no workflow. The handoff at
23:31:23 was therefore never delivered, never evaluated, and never advanced.

An earlier, *separate* failure on the same machine — a 0.1.4 daemon halting the
workflow with "unknown workflow type" — was version skew that the 0.2.0 upgrade already
resolved. The daemon in this incident is confirmed 0.2.0. This spec is **not** about
version skew and **not** about the `complex-bug-fixing` workflow itself: the same split
would strand an SDD or ralph run identically.

## Confirmed workaround

The following sequence reliably unblocked the incident and is the current manual remedy:

1. `whisper workflow cancel <workflowId>` — abandon the orphaned run.
2. Consolidate to a single collab. On a dev/test box the clean reset is: `whisper
   collab stop`, kill any stray `broker-daemon` pids, `rm ~/.ai-whisper/state.db`,
   re-mount **once**.
3. Start a fresh run. The new workflow is created on the same collab the live agents
   are mounted on, so its handoff delivers and the run proceeds.

This is a workaround, not a fix — it depends on the operator noticing the split, which
requires reading `state.db` directly.

## Root cause

`resolveCollab` → `lookupByCwd` (`packages/cli/src/runtime/collab-resolver.ts`) selects
`WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1` — it
tolerates multiple active collabs and silently prefers the newest. **Nothing at
collab-creation/mount time prevents a second active collab for a `workspace_id` that
already has one.** After a machine restart, a re-mount produced a new collab
(`…233022`) while the prior collab (`…231627`) — which owned the in-flight workflow —
remained `active`, rather than the existing collab being re-adopted. With two active
collabs, a workflow created/pinned to one can have its live agents on the other, and no
layer raises an error.

## Design

Three coordinated changes; all enforce a single invariant: **at most one `active`
collab per `workspace_id`.**

### 1. Mount/start — app-level re-adopt (primary path)

`packages/cli/src/commands/collab/start.ts` (reached through `collab/mount.ts`) is where
a collab is created for a workspace. Before inserting a new collab row, it must look up
an existing `active` collab for the resolved `workspace_id`:

- **If one exists, re-adopt it transparently:** reuse that collab row (do not insert a
  new one), bring its daemon back through mount's *existing* spawn-daemon-if-needed +
  `waitForBrokerReady` logic if no live daemon is attached, then bind the agent into it.
  From the operator's view a single `whisper collab mount` "just works" — whether the
  collab is freshly created, already healthy, or being revived after a restart.
- **Only when no `active` collab exists for the workspace** does mount create a new
  collab row (today's behavior).
- Re-adoption distinguishes a **dead daemon** (respawn transparently) from a **healthy
  daemon** (reuse as-is) using the same liveness signal the resolver already computes
  (`getBrokerDaemonByCollab` → `pid !== null` and pid-alive). It must **reuse the
  existing recover/reconnect machinery rather than reimplement it**; transparent
  re-adopt is a thin front-end over those paths, not a parallel one.
- The explicit `--collab <id>` override path is unchanged: it still resolves to exactly
  the named collab.

### 2. Storage — partial unique index (hard backstop)

Add a partial unique index so the invariant cannot be violated even by a future caller
that bypasses the mount path:

```
CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_one_active_per_workspace
  ON collab(workspace_id) WHERE status = 'active';
```

Insertion of a second active collab for a `workspace_id` then fails at the storage
layer. The mount path (change 1) is written so it never relies on hitting this error in
the normal case — the index is defense-in-depth, not control flow.

**Index creation is all-or-nothing and table-wide.** SQLite has no per-workspace index
scope: this single index either covers every `workspace_id` or does not exist. There is
no way to "exclude one workspace" from a `WHERE status = 'active'` predicate. Therefore
the migration (change 3) must guarantee zero residual active-duplicates table-wide
*before* attempting `CREATE UNIQUE INDEX`; if any irreducible duplicate remains, the
index is **not created at all** for that startup. This constraint drives the conflict
handling below.

### 3. Migration — resolve existing duplicates before the index

A partial unique index cannot be created while duplicate active rows exist, and real
installs already have them (the incident machine has two). The migration runs **before**
the index creation, per `workspace_id`:

- Gather all `active` collabs for the `workspace_id`.
- **Pick the survivor by this order:** (a) a collab that owns a **running** workflow;
  else (b) a collab with a **live daemon** (pid present and alive); else (c) the
  **newest** by `created_at`.
- Mark every non-survivor `status = 'stopped'` (a status flip — **never delete rows**,
  so history/workflows are preserved and auditable).
- **Conflict case — two or more candidates own running workflows:** do **not**
  auto-pick (auto-stopping a collab with a live run is the orphaning failure we are
  fixing). Leave those rows `active` and emit a clear startup warning naming the collabs
  and instructing manual `whisper collab stop`. Because the index is table-wide
  (see above), a residual active-duplicate means **the index is not created at all for
  this startup** — it cannot be "skipped for one workspace." Concretely: after running
  the survivor selection across all workspaces, re-check for any residual active-duplicate;
  if none remain, create the index; if one or more remain, **skip `CREATE UNIQUE INDEX`
  entirely, log the warning, and let daemon startup proceed without the backstop index.**
  The index is created automatically on a later startup once the operator has manually
  stopped the extra collab(s) and no duplicate remains. Index creation must never crash
  daemon startup on residual state.

## Non-regression (hard requirements)

- **Single workspace, one collab, normal mount → start → run** is byte-for-byte
  unchanged in resolution and binding. Locked by an existing-behavior regression test.
- **`--collab` / `collabIdOverride`** resolves to exactly the named collab, unchanged.
- **Recover / reconnect** after a daemon or session drop continues to re-attach to the
  existing collab. Transparent re-adopt (change 1) must **reuse** this path, and must
  not turn a recoverable collab into an error or a duplicate.
- **Distinct workspaces** (`workspace_id` differs) keep independent collabs — the
  invariant is per-`workspace_id`, never global.
- **Migration safety:** never deletes a row; never marks a collab that owns a running
  workflow `stopped` except when another surviving collab is chosen *because it owns the
  running workflow*; the two-running-workflows conflict never silently drops either.
- **Daemon startup must not crash** on pre-existing irreducible duplicate state; worst
  case it logs a warning and proceeds without the (table-wide) backstop index until a
  later startup finds no residual duplicate.

## Testing

### Regression guards (must pass unchanged)
- Single active collab per workspace: mount reuses it; resolve/start/run proceed exactly
  as today.
- `--collab` override resolves to the named collab.
- Recover → reconnect re-attaches to the existing collab; no new collab created.
- Two distinct workspaces keep two independent active collabs.

### New coverage (the fix)
- **Re-adopt:** mounting into a workspace that already has an `active` collab reuses it —
  assert no second `active` row is created for that `workspace_id`.
- **Post-restart transparent re-adopt:** existing `active` collab whose daemon pid is
  dead → mount brings a fresh daemon back and binds the agent, ending with exactly one
  active collab and a live daemon (no separate recover command required).
- **Index backstop:** a direct attempt to insert a second `active` collab for a
  `workspace_id` is rejected by the unique index.
- **Migration tie-break:** given duplicates where an *older* collab owns a running
  workflow and a *newer* one does not, the migration keeps the **older** (workflow-owning)
  collab active and stops the newer — i.e. the incident outcome is inverted.
- **Migration liveness fallback:** no running workflow on either → keeps the one with a
  live daemon; neither live → keeps newest.
- **Migration conflict:** two active collabs both own running workflows → both remain
  active, a warning is emitted, `CREATE UNIQUE INDEX` is skipped table-wide for this
  startup (the residual duplicate makes the index uncreatable), and **neither workflow is
  orphaned**; daemon startup still succeeds. A follow-up assertion: once the duplicate is
  resolved, a subsequent startup creates the index.
- **Repro-as-test:** seed the exact incident shape (workflow bound to collab A, fresh
  mount attempted for the same workspace) and assert mount re-adopts A instead of
  creating B — the split cannot recur.

## Out of scope

Recorded so the scoping decision is traceable; each could be a later spec:

- **Resolution that prefers the live collab + warns on duplicates** (the "B" option):
  unnecessary once duplicates cannot form. If the index/migration ever leaves a residual
  conflict, that path is the natural place to surface it — revisit then.
- **Fail-fast guard at `whisper workflow start`/`resume`** (the "C" option): refusing
  when the resolved collab's agents are not live-mounted. Cheap insurance and good UX,
  but a distinct concern from preventing duplicates; deferred.
- **`status --json` mount-liveness signal** so the kickoff skills' readiness gate can
  catch a dead mount before kickoff. The incident also exposed that `status` reports
  healthy for a collab whose mount the dashboard considers dead — worth its own spec.

## Open questions

Both are narrow enough to settle in the implementation plan:

- The exact "live daemon" liveness probe used **inside the migration** (reuse the
  resolver's `pid !== null` + `process.kill(pid,0)` check vs a lighter pid-presence
  test, given migration runs at daemon startup).
- The precise index-creation strategy when an irreducible duplicate remains after
  migration (create-only-if-clean vs attempt-and-downgrade-to-warning).
