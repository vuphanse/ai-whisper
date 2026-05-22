# Dashboard UX fixes — design

Date: 2026-05-22
Status: approved-for-planning

## Problem

Three dashboard UX defects surfaced during smoke + dogfooding. All three are in the
collab/workflow dashboard read path (`dashboard-repository` →
`relay-view-state`/`dashboard-state` → `dashboard-view`), plus a session-lifecycle
touch for Bug A. Root causes were triaged against the code and confirmed with live
`state.db` evidence.

**Bug A — a live agent shows "(dead)" after stop + re-mount.**
Each mount inserts a NEW `session` row (`mount-session-main.ts` creates a fresh
`sessionId`; `insertSession` is INSERT-only). Stop/teardown marks the session
`degraded` (`markSessionDegraded`). Old rows are never reaped. The dashboard agent
query (`dashboard-repository.ts:137`) selects ALL `session` rows for the collab
`ORDER BY registered_at ASC`, and the consumer (`relay-view-state.ts:288`) takes the
FIRST match per agent — i.e. the oldest, stale, `degraded` row from a prior mount —
so a freshly re-mounted healthy agent renders `●(dead)`. Evidence: collab
`…ec55131f` has 2 `degraded` session rows per agent. Secondary: `ok = healthState
=== "healthy"` (`relay-view-state.ts:289`) renders `degraded` identically to dead.

**Bug B — only one workflow per collab; no run history.**
The collab-summary workflow lookup (`dashboard-repository.ts:71-75`) ends in
`LIMIT 1` (running first, else most recent). The `workflows` table holds the full
history, but the dashboard never enumerates it. Evidence: collab `…ec55131f` has 3
workflows; the dashboard surfaces 1.

**Bug C — false "STUCK" at 60s.**
`relay-view-state.ts:220-221`: `stuckThresholdMs = Math.max(60_000, idleThresholdMs
* 2)`, with `idleThresholdMs` defaulting to 30s → 60s. `:246` flags STUCK once
`idleMs >= stuckThresholdMs`, where `idleMs` is time since the last `relay_handoff`
activity for the run. A legitimate long step (an LLM review pass, an execution
phase) produces no relay-handoff activity for minutes while the agent is actively
working, so the 60s gate fires a false STUCK. Two faults: (1) the threshold is far
too short for real agent steps; (2) it is derived from the **turn-idle** threshold
(whose real job is turn-completion / auto-accept detection) and keyed off
handoff-idle, which cannot distinguish "working a long step" from "hung."

## Goal

Make the dashboard reflect the **current** session per agent (not a stale one),
expose **all** workflows a collab has run, and stop flagging legitimately
long-running steps as STUCK — using signals already available in `state.db` plus a
local pid-liveness check.

## Non-goals

- New provider-output ("token streaming") telemetry/plumbing. Bug C uses
  handoff-idle + a decoupled threshold + mount **pid-liveness**, not a new
  per-token activity feed.
- The `workflow-driver` collab-scoping bug (separate backend issue; out of scope).
- Redesigning the dashboard layout/visuals beyond what these three fixes require.

## Design

### Bug A — reflect the active session; reap stale rows

**Read path (symptom fix).** Agent health must key off the **current bound session**
per agent, not the oldest `session` row:

- `dashboard-repository` agent-sessions query: return one row per `agent_type`,
  preferring the session whose `session_id` equals the agent's
  `session_binding.activeSessionId`; if there is no binding, fall back to the row
  with the greatest `registered_at`. (Equivalently: join `session` to
  `session_binding` on `active_session_id`, plus a latest-row fallback.)
- `relay-view-state.ts` agent dots: consume that already-deduped per-agent health;
  do not `.find()` the first arbitrary row.
- Render `degraded` distinctly from dead. Mapping: `healthy → "●"`, `degraded →
  "◐(degraded)"`, `offline`/missing/dead-pid → `"●(dead)"`. (Exact glyphs may be
  tuned in implementation; the requirement is that a bound, non-offline agent does
  not read "dead".)

**Reap (root fix).** Stale `session` rows must not accumulate:

- On **re-mount** of a `(collab, agent)` and on **stop/teardown**, delete the
  superseded `session` rows for that `(collab, agent)` — keep only the row that is
  (or just became) the active/bound session. Implement as a repository function
  (e.g. `reapSupersededSessions(collabId, agentType, keepSessionId)`) called from
  the mount registration path and the teardown path in `mount-session-main` /
  control service.
- Guard: reaping is best-effort and wrapped so a failure never breaks mount/stop
  (matches the existing `recordMountedSession` best-effort pattern).
- Because reaping keeps the table to one row per `(collab, agent)`, the read-path
  fix and the reap are belt-and-suspenders: the read path is correct even if a
  stale row briefly exists (e.g. mid-re-mount), and the reap keeps the table clean.

### Bug B — Inspector workflow-history list

- Drop `LIMIT 1` from the collab-summary workflow lookup OR leave the Wall summary
  as-is (it should still highlight the active/latest) and add a **separate** repo
  query `listWorkflowsForCollab(collabId)` returning every workflow (workflowId,
  workflowType, name, status, currentPhaseIndex, createdAt), newest first.
- `dashboard-state` builds an **Inspector workflow-history** list from that query.
  Selecting a workflow in the Inspector renders the existing phase/round timeline
  for that `workflowId` (the timeline builder already takes a workflow + its phase
  runs; feed it the selected workflow's data).
- The Wall continues to surface the active/latest workflow per collab (unchanged
  behavior there). This is purely additive on the read/UI side; no schema changes.

### Bug C — decoupled, phase-aware stuck threshold + pid-liveness

**Decouple + widen.** Introduce a dedicated stuck threshold independent of the
turn-idle threshold:

- New constant/env `AI_WHISPER_STUCK_THRESHOLD_MS`, default **300_000 (5 min)**.
- `stuckThresholdMs` no longer derives from `idleThresholdMs * 2`.

**Phase/step-aware budget.** The budget before "stuck" depends on the current step:

- quick handoff acknowledgement / `review`-request waiting on a human-style ack:
  baseline (5 min).
- `execute` (plan-execution) and `review` passes (LLM doing real work): **600_000
  (10 min)**.
- The step is already available to the snapshot (`snap.currentStep` /
  phase config); map step → budget with a small table, env-overridable.

**pid-liveness corroboration.** Past the budget, distinguish "working" from "hung":

- The dashboard **host** (`dashboard.ts`, not the pure builders) checks whether the
  mount process is alive: read the mounted `session_attachment.pid` for the
  agent(s) and probe with `process.kill(pid, 0)` (locally; the dashboard and mounts
  share one machine). Produce a boolean `mountAlive` per agent.
- `computeLiveness` takes `mountAlive` (and existing session health) as input and
  stays pure/unit-testable. Decision:
  - idle < budget → not stuck (normal countdown / "working").
  - idle ≥ budget AND `mountAlive` → **"long-running"** (NOT stuck): why-text e.g.
    `"long-running ${dur} — step in progress (mount alive)"`.
  - idle ≥ budget AND NOT `mountAlive` (or session offline) → **STUCK**:
    `"STUCK ${dur} — no progress and mount not alive"`.
- The existing higher-precedence STUCK reasons (halt_reason, chain
  escalated/abandoned, round-max) are unchanged and still take precedence.

`session_attachment.pid` is recorded once at mount (`recordMountedSession`); no new
periodic heartbeat is added. If a `session_attachment` row or pid is absent, treat
`mountAlive` as unknown→false (conservative: allow STUCK) so the signal never
masks a real hang.

**Reconcile the existing "provider unhealthy" branch.** `relay-view-state.ts:249`
currently sets `stuck=true` for ANY non-healthy session (`sessions.some(s =>
s.healthState !== "healthy")`), regardless of idle. After Bug A (bound-session
selection feeds only the active session) this must be softened so it agrees with
the degraded≠dead and pid-liveness rules: a **`degraded` but alive** bound agent is
NOT stuck. Treat only `offline` (or dead-pid) as the unhealthy→stuck trigger;
`degraded` on its own does not set `stuck` (it renders as degraded). This keeps the
two stuck paths (idle-budget+pid, and session-health) consistent.

## Components touched

- `packages/broker/src/storage/repositories/dashboard-repository.ts` — active/bound
  session selection (Bug A), `listWorkflowsForCollab` (Bug B).
- `packages/broker/src/storage/repositories/session-repository.ts` (or sibling) —
  `reapSupersededSessions` (Bug A).
- `packages/cli/src/runtime/mount-session-main.ts` + control service — call reap on
  mount/teardown (Bug A).
- `packages/cli/src/runtime/relay-view-state.ts` — degraded≠dead rendering (Bug A);
  decoupled/phase-aware threshold + `mountAlive` input in `computeLiveness` (Bug C).
- `packages/cli/src/runtime/dashboard-state.ts` — Inspector workflow-history (Bug B);
  thread `mountAlive` through (Bug C).
- `packages/cli/src/runtime/dashboard.ts` (host) — pid-liveness probe feeding
  `mountAlive` (Bug C).
- `packages/cli/src/runtime/dashboard-view.tsx` — render history list (Bug B),
  long-running vs stuck vs dead states (Bug A/C).

## Testing

Unit tests (pure builders — deterministic):

- **Bug A:** given multiple `session` rows for an agent (old `degraded` + new
  `healthy` bound), the per-agent health resolves to the bound/healthy one →
  rendered `●`, not `●(dead)`. A `degraded` bound session renders as degraded, not
  dead. `reapSupersededSessions` deletes non-kept rows for the `(collab, agent)` and
  leaves the kept one (repo test against a temp DB).
- **Bug B:** `listWorkflowsForCollab` returns all workflows newest-first for a collab
  seeded with ≥2 workflows; `dashboard-state` produces a history list of that length;
  selecting a non-active workflow yields its timeline.
- **Bug C:** `computeLiveness` table-tests:
  - idle just under budget → not stuck.
  - idle over baseline budget on an `execute`/`review` step but under the larger
    step budget → not stuck (phase-aware).
  - idle over budget AND `mountAlive=true` → "long-running", `stuck=false`.
  - idle over budget AND `mountAlive=false` → `stuck=true`.
  - env override of `AI_WHISPER_STUCK_THRESHOLD_MS` changes the boundary.

Host-level: a focused test (or documented manual check) that the pid probe maps a
live pid → `mountAlive=true` and a dead/absent pid → `false`. Keep the
`process.kill` probe out of the pure builders so they stay deterministic.

Full gate: build, typecheck, lint, test green.

## Acceptance criteria

1. After stop + re-mount of a collab, a healthy bound agent renders as alive (not
   "(dead)"); a `degraded` bound agent renders distinctly from dead. Verified by a
   unit test with stale + active session rows.
2. Stale `session` rows for a `(collab, agent)` are reaped on re-mount and on
   stop/teardown, leaving one active row; reaping failure never breaks mount/stop.
3. The dashboard read path selects the bound session (`activeSessionId`), falling
   back to latest `registered_at`, not the oldest row.
4. `listWorkflowsForCollab` enumerates all workflows for a collab; the Inspector
   shows a workflow-history list and can render the timeline of a selected past
   workflow. The Wall still highlights the active/latest.
5. The stuck threshold is independent of the turn-idle threshold, defaults to ≥5 min,
   is env-configurable, and is larger for `execute`/`review` steps.
6. A step idle past its budget but with a live mount pid is reported as
   "long-running", not "STUCK"; only idle-past-budget with a dead/absent mount pid
   (or offline session) reports "STUCK". A `degraded`-but-alive bound agent is NOT
   stuck (the `sessions.some(non-healthy)` branch triggers only on `offline`/dead).
   Higher-precedence stuck reasons (halt/chain/round-max) are unchanged.
7. pid-liveness is computed in the dashboard host and passed into the pure
   `computeLiveness`; builders remain deterministic and unit-tested.
8. Full repo verification (build, typecheck, lint, test) stays green.

## Risks / edge cases

- **Reap deletes the wrong row** — keyed on the kept/active `session_id`; unit-tested
  to delete only superseded rows for that `(collab, agent)`.
- **No binding yet at read time** — fall back to latest `registered_at`; documented.
- **pid reuse** — a recycled pid could read alive falsely; acceptable for a local
  dashboard heuristic (worst case: a hung step shows "long-running" briefly). The
  higher-precedence halt/chain/round-max reasons still catch real terminal states.
- **Dashboard on a different host than mounts** — out of scope; the product is
  local (shared `state.db`, local pids).
- **Phase-aware budget mis-mapped step** — unmapped steps fall back to the baseline
  threshold (never shorter), so the change can only relax false STUCKs, not tighten.
