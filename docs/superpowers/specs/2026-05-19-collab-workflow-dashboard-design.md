# Collab/Workflow Dashboard — Design

Date: 2026-05-19
Status: Draft (brainstormed, pending plan)
Backlog: improvement #2 ("shared component, #1 then #2"); builds on the shipped
relay-monitor redesign (#1).

## 1. Problem & Goal

Today the only live view is `collab relay-monitor`, scoped to a single collab.
When several collabs/workflows run concurrently there is no at-a-glance view,
and there is no way to **evaluate** a run after the fact: whether the workflow
configuration is well-tuned, *why* a run stuck/escalated (with concrete
evidence), or how much time/tokens it cost.

The dashboard is a single full-screen Ink TUI with two modes:

- **Wall** — a live, auto-populated, attention-sorted multi-pane overview of
  recently-active collabs ("which of my runs needs me, right now").
- **Inspector** — a per-run drill-down (opened from a wall pane) that answers,
  for one run: what is it doing (Live), how did each phase go (Timeline), *why*
  did it stick/escalate with concrete evidence (Evidence), and what did it cost
  in time and (estimated) tokens (Cost).

It maximizes reuse of #1's shared pieces: the pure `relay-view-state`
projection layer, the `<RelayView>` component + its input, and the
mutation-aware `listRelayHandoffs` snapshot read.

## 2. Locked Decisions (from brainstorming)

1. **Wall = live multi-pane wall** (not a launcher/table/master-detail).
2. **Pane population = automatic, attention-sorted**: every eligible collab is
   auto-tiled; sort `stuck > active > idle > done`, tiebreak `lastActivity`
   desc; overflow is **paged** (`[` / `]`); a newly-stuck run auto-surfaces via
   the sort across pages.
3. **Board universe = recently-active only**: a collab is eligible if its
   workflow is `running` OR it had relay activity within a recency window
   (default 30 min; env-overridable, mirroring `AI_WHISPER_IDLE_THRESHOLD_MS`).
   Finished runs show briefly (`✔/✖`) then age out.
4. **Pane density = "B"**: per pane — a header line (collab · workflow type ·
   `P{n}/{N} R{r}/{m}`), a health/liveness line (`● codex ● claude  Chain … ·
   ALIVE` or `⚠ STUCK …`), and the **two newest log one-liners**. ~4 panes on a
   typical terminal; grid is responsive to terminal size with a minimum pane
   size; one logical line never wraps (truncate to width).
5. **Drill-down = Inspector** (replaces the plain relay-monitor focus). `Enter`
   on the selected pane opens the Inspector for that run; `Esc` returns to the
   Wall.
6. **Inspector has four sections**: `Live | Timeline | Evidence | Cost`,
   switched by `1`/`2`/`3`/`4` (or Tab). **Live** is the existing
   `<RelayView>` full + its scroll/follow input, unchanged.
7. **Architecture = unified Ink app + one new summary read** (Approach 1): a
   single new read-only broker query for the wall sort/headers; per-pane and
   Inspector detail reuse existing per-collab reads. One process, one poll loop.
8. **v1 unit of analysis = per-run** (a "run" = a recently-active collab
   resolved to its current-or-most-recent workflow run, or its manual-relay
   activity; see "Unit of identity", §3). Cross-run aggregation by workflow *type*
   (e.g. "spec-driven-development avg rounds/phase across N runs") is an
   explicit **v1 non-goal**, deferred. Per-run signals are chosen so config
   problems are still eyeball-obvious.
9. **Quality evaluation = concrete signals only** (rounds vs maxRounds, verdict
   mix, escalation/halt reason, time & est-tokens per phase). **No
   LLM-as-judge** in v1.
10. **Tokens = labeled estimate** `≈ ceil(len/4)` over persisted text. There is
    no real token/usage accounting in the codebase; v1 surfaces raw estimated
    input/output totals + per-phase, always rendered as `≈ … (est, not
    metered)`.
11. **Evidence = handoff chain + reason excerpts + diagnostics**: per-handoff
    round/step/verdict/confidence/reason-excerpt/capture_status for the
    stuck/escalated phase, plus the matched evaluator/capture diagnostic rows,
    plus one plain-language "likely cause" heuristic line. Full text stays in
    the Live log; Evidence excerpts, it does not duplicate.

## 3. Architecture — Three Isolated Units

Mirrors #1's discipline: each unit has one purpose, a well-defined interface,
and is independently testable. No `<Static>`; full-screen alt-screen Ink app.

### Unit A — Broker reads (read-only, mutation-aware by construction)

All reads return **current rows** (no incremental cursor). This is a hard
requirement learned from #1: `relay_handoff` mutates in place
(pending→handed_back→evaluated); any cached/cursored read goes stale. Every
poll re-reads fresh and merges by id.

**Unit of identity (resolves F2):** a pane / Inspector represents a **run**,
defined as *a recently-active collab resolved to its current-or-most-recent
workflow run*. The schema enforces at most one `running` workflow per collab
(`workflows_one_running_per_collab` UNIQUE), so resolution is deterministic and
mirrors #1's host: `runWorkflowId = the running workflow, else the
most-recently-created workflow, else null (manual-relay run)`. Each summary row
is one such resolved run, keyed by `collabId` (its current run) and carrying
the resolved `workflowId` (nullable = manual relay). Throughout this spec
"run" / "selected run" means exactly this resolved entity; the Inspector is
scoped to that run's `workflowId` (or the collab's relay activity when null).

- **New:** `listActiveCollabSummaries(db, { sinceMs })` → `CollabSummary[]`,
  one row per eligible **resolved run** (§2.3 recency filter), each carrying
  the minimal status tuple for the wall sort + pane header: `collabId`, `label`
  (= workflow name if set, else collab cwd basename, else short collabId),
  `workflowId` (nullable — null = manual-relay run), `workflowType`,
  `workflowStatus`, `currentPhaseRunId`, `phaseIndex`, `phaseName`,
  `currentRound`, `maxRounds`, `chainStatus`,
  `turn{owner,waiting,handoffState}`, `sessions[]{agentType,healthState}`,
  `lastActivityAt`. Single recency-filtered query/joins; exposed on
  `broker.control`; row type re-exported from the broker index.
- **New (Inspector Cost detail, resolves F1):** `listRunCostRows(db,
  { collabId, workflowId })` (when `workflowId` is null → manual-relay run:
  scope to that collab's `workflow_id IS NULL` handoffs) → per-handoff
  `{ phaseRunId, createdAt, resolvedAt, lastActivityAt, inChars, outChars }`
  (`lastActivityAt` is `relay_handoff.last_activity_at`, NOT NULL — the
  fallback for in-progress handoffs whose `resolvedAt` is still null) where `inChars = len(request_text) +
  len(root_request_text)` and `outChars = len(handback_text)`. It returns
  **character counts and timestamps only — never raw request/handback text**
  (privacy + perf: the wall path must not pull large text every poll;
  `estimateTokens` needs only lengths). `listRelayHandoffs`'
  `RelayHandoffLogRow` deliberately does **not** carry
  `requestText/rootRequestText/resolvedAt`, so Cost uses this dedicated
  Inspector-only read, not an expansion of the wall snapshot.
- **Reused, existing:** `listRelayHandoffs(collabId, K)` (mutation-aware
  snapshot, K≈8 for panes / larger for Inspector Live/Evidence), `getWorkflow`
  (workflow `createdAt`/status for Cost total time), `getWorkflowPhaseRuns`
  (per-phase `startedAt/endedAt/outcome`), `getRelayChain`,
  `getRelayTurnState`, `listSessions`, and the diagnostics reads
  `listEvaluatorDiagnosticsByCollab[AndChain]` +
  `listCaptureDiagnosticsByCollab[AndChain]`.
  - **Acceptance note:** the diagnostics repo functions exist; their
    `broker.control` exposure (and `listRunCostRows`) must be added if absent —
    additive, read-only, collab-scoped, current-rows.

### Unit B — Pure analysis layer (no IO, no Ink)

- `buildWallState(summaries, perPaneSnapshots, now, viewport)` → `WallState`:
  attention sort (§2.2), pagination to grid capacity, and a per-visible-pane
  projection. Each pane's vitals/health/why is produced by **reusing
  `buildRelayViewState`** (which internally runs `computeLiveness` and yields
  `RelayViewState.health/why/stuck` — the pane reads those; it never calls
  `computeLiveness` directly); the two log lines by reusing `deriveLogLines`
  (tail 2).
- `buildInspectorState(run)` → `{ live, timeline, evidence, cost }`:
  - `live`: `RelayViewState` from `buildRelayViewState` (it *is* the
    `<RelayView>` input — identical to #1).
  - `timeline: PhaseStat[]` — `{ phaseIndex, phaseName, roundsUsed,
    maxRounds, durationMs (fmtDur), outcome, estTokens }` per phase + a TOTAL.
  - `evidence: { phase, chainId, items: EvidenceItem[], diagnostics:
    DiagItem[], likelyCause: string }` — `EvidenceItem` =
    `{ round, step, sender, target, verdict, confidence, reasonExcerpt,
    captureStatus }` for the focused (stuck/escalated, else current) phase
    run; `diagnostics` from the evaluator/capture diagnostic rows for that
    chain; `likelyCause` a deterministic heuristic string (e.g. "5/5 rounds,
    verdict never reached approve, confidence declining → under-specified
    input or maxRounds too low").
  - `cost: { totalMs, estInputTokens, estOutputTokens, perPhase[] }` — from
    `listRunCostRows`: `estInputTokens = ceil(Σ inChars / 4)`,
    `estOutputTokens = ceil(Σ outChars / 4)`, grouped by `phaseRunId` for the
    per-phase breakdown. `totalMs = max(over rows: resolvedAt ??
    lastActivityAt) − workflow.createdAt` (for manual-relay runs, where there
    is no workflow: `max(resolvedAt ?? lastActivityAt) − min(createdAt)` over
    the run's handoffs). All timestamps come from `listRunCostRows` /
    `getWorkflow`.
    `estimateTokens(chars) = ceil(chars / 4)` operates on the lengths the cost
    read returns (no raw text in this layer).
  - Pure helpers reused: `fmtDur`, `buildRelayViewState`, `deriveLogLines`
    (`computeLiveness` is exercised indirectly via `buildRelayViewState`, not
    called directly — it is private to `relay-view-state.ts`). New pure
    helper: `estimateTokens` (single source,
    exported, deterministic).

### Unit C — Ink components + host

- `<WallPane>` (density B) and `<Wall>` (responsive grid: cols×rows derived
  from terminal size & a minimum pane size — target floor ≈ 40 cols × 5 rows
  per pane, clamped to ≥1 pane; stuck-first ordering, page indicator).
- `<Inspector>` — chrome (run identity + section tabs + `Esc`/`q`) plus the
  four section renderers. **Live** = the existing `<RelayView>` full +
  `relay-view-input`/`handleKey`, reused unchanged. **Timeline/Evidence/Cost**
  = new compact, width-truncated, scroll-aware section renderers (reuse the
  gutter/`logViewportHeight`/truncate conventions from #1).
- `createDashboardRuntime(...)` host — mirrors `createRelayMonitorRuntime`:
  single Ink render, one async poll loop, signal handling + terminal restore,
  guaranteed-exit fallback, `__`-prefixed test/seam hooks
  (`__viewport`, `__handleKey`, `__mode`, `__bufferLen`, `__pollHealth`).
  Signature kept small and stable.

## 4. Data Flow

**Wall poll (interval default 250 ms):**
`listActiveCollabSummaries({ sinceMs })` → attention-sort → paginate to grid
capacity → for the ≤N **visible** panes only, `listRelayHandoffs(collabId, K≈8)`
(K > 2 so that after `deriveLogLines` interleaves phase-rule/summary lines
there are still ≥2 *event* lines for the pane tail) →
`buildRelayViewState`/`deriveLogLines` → `buildWallState` → `ink.rerender`.
Off-screen collabs cost only their row in the one summary query, so a
newly-stuck run still surfaces via the sort/paging.

**Inspector poll:** for the focused run — `listRelayHandoffs(collabId,
larger)`, `getWorkflow`, `getWorkflowPhaseRuns`, `getRelayChain`,
`getRelayTurnState`, `listSessions`, evaluator/capture diagnostics, and
`listRunCostRows({ collabId, workflowId })` (Cost section) →
`buildInspectorState` → render the active section. All four sections recompute
each tick so a running phase updates live; Live keeps the #1 monitor
scroll/follow behaviour.

**Mode switch:** `Enter` on a wall pane → Inspector for that pane's **resolved
run** (the collab's running-or-most-recent workflow run, or its manual-relay
run when `workflowId` is null — see "Unit of identity", §3); `Esc` → Wall
(wall polling resumes). One poll loop; the active mode determines which reads
run.

## 5. Interaction

- **Wall:** arrows / `hjkl` move pane selection · `Enter` open Inspector ·
  `[` / `]` page · `q` quit. Sort is automatic.
- **Inspector:** `1`/`2`/`3`/`4` (or Tab) switch section; in **Live**, the
  monitor scroll/follow keys (`g`/`G`/`f`, arrows) apply; `Esc` → Wall;
  `q` quit.
- Recency window: `AI_WHISPER_DASHBOARD_WINDOW_MS` (default 1_800_000),
  guarded parse (NaN/≤0 → default), mirroring #1's threshold handling.

## 6. Errors & Edge Cases

- **Failed poll** → keep last frame, record `pollHealth` (consistent with #1's
  degrade-silently choice; visible degraded indicator remains the #1-deferred
  item, still out of scope here).
- **Empty board** → "no active collabs (last 30m)" centered state.
- **Terminal too small** for even one pane → render one pane / a message;
  recompute grid on resize.
- **Manual-relay collab** (no workflow) in Inspector → Timeline/Cost degrade
  ("relay only — no workflow phases"); Evidence = handoff chain without
  phase/verdict columns; Live unchanged.
- **Short/empty text** → `estimateTokens` = 0; never `NaN` (guarded).
- **Focused run goes terminal / ages out** while open → Inspector renders the
  last-known read-only state (it is history); `Esc` returns to Wall.
- **Bounded cost:** one summary query + ≤N small snapshot reads per wall tick;
  Inspector reads are single-collab. Snapshot reads stay capped (reuse the
  `BUFFER_CAP`/limit convention).

## 7. Testing Strategy (TDD, #1 rigor)

- **Unit (broker):** `listActiveCollabSummaries` — recency filter, join
  correctness, run resolution (running vs latest-terminal vs manual-relay),
  **in-place mutation reflected on re-read** (regression-class test from #1),
  unknown/empty. `listRunCostRows` — per-phase length aggregation,
  workflow-scoped vs manual-relay (`workflow_id IS NULL`) scoping, returns
  counts/timestamps only (asserts no raw text leaks), in-place mutation
  reflected.
- **Pure:** `buildWallState` (attention sort incl. stuck-first, pagination,
  per-pane projection, empty); `buildInspectorState` (timeline math,
  deterministic `estimateTokens`, evidence assembly incl. escalated +
  manual-relay degrade + likelyCause heuristic, cost per-phase).
- **Ink:** `<WallPane>`/`<Wall>` (density-B layout, responsive grid, paging,
  one-liner truncation); `<Inspector>` (chrome, section switching, each section
  renderer, truncation/scroll).
- **Host:** Wall↔Inspector switch, fan-out poll, signals + terminal restore,
  degraded-but-alive, double-start guard.
- `fakeBroker` models the summary + diagnostics reads with **fresh-copy
  fidelity** (a stale buffered reference must not silently update — the #1
  regression lesson); doubles reproduce the insert-then-mutate lifecycle.

## 8. Reuse / Seams

Reused unchanged, **imported from where they actually live** (resolves F3):
- from `relay-view-state.ts` (exported): `buildRelayViewState`,
  `deriveLogLines`, `fmtDur`. `computeLiveness` is **private** there and is
  reused only *indirectly* via `buildRelayViewState` (not imported, not called
  directly — no new export required).
- from `relay-view.tsx` (exported): `STATUS_ROWS`, `logViewportHeight` (and
  `STATUS_BLOCK_ROWS`) — these are **not** in `relay-view-state.ts`.
- `<RelayView>` + `relay-view-input` (Inspector "Live"); the mutation-aware
  `listRelayHandoffs`; the existing evaluator/capture diagnostics repo reads.

No new exports are added to existing modules for reuse; if a needed value were
private it would be stated as an explicit spec change (none is — see above).

Genuinely new: `listActiveCollabSummaries` + `listRunCostRows` (broker reads),
`buildWallState` + `buildInspectorState` + `estimateTokens` (pure),
`<Wall>`/`<WallPane>` + `<Inspector>` (Ink), `createDashboardRuntime` (host),
the `collab dashboard` CLI command.

## 9. Acceptance Criteria

1. `collab dashboard` opens a full-screen wall of recently-active collabs,
   stuck-first, paged, density-B panes, ~250 ms live refresh, `q` restores the
   terminal.
2. A newly-stuck off-screen run surfaces to page 1 via the sort without manual
   action.
3. `Enter` opens the Inspector for the selected run; `Esc` returns; `1–4`
   switch sections; Live behaves exactly like `collab relay-monitor`.
4. Timeline shows per-phase rounds-vs-maxRounds, duration, est tokens, outcome,
   and a TOTAL; the round-cap case is visually flagged.
5. Evidence shows the escalated/stuck phase's handoff chain with
   verdict/confidence/reason excerpts + evaluator/capture diagnostics + a
   deterministic likely-cause line.
6. Cost shows total wall-clock + estimated input/output tokens (labeled
   `≈ est, not metered`), per phase.
7. Manual-relay collabs and empty/edge states degrade gracefully (no crash, no
   `NaN`).
8. Full suite + typecheck + lint + build green; new reads are mutation-aware
   and covered by an insert-then-mutate regression test.

## 10. Non-Goals (v1)

- Cross-run / by-workflow-type aggregation and trends.
- LLM-as-judge quality scoring.
- Real (metered) token/cost accounting — v1 is a labeled char-length estimate.
- Mutating actions from the dashboard (halt/resume/retry) — read-only.
- The visible "broker degraded" indicator (still the #1-deferred item).
- Persisting/exporting reports.

## 11. Deferred / Future

- By-type aggregate console (avg rounds/phase, escalation rate, cost trend
  across runs) — natural follow-up once per-run Inspector ships.
- Real token accounting if/when adapters expose usage.
- Optional enriched wall badges (est-tokens/time on the pane) — deferred
  per pane-size constraint; revisit after dogfooding.
