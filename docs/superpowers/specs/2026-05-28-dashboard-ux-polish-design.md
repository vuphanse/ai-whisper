# Dashboard UX Polish — Status-First Cards + Grouped Wall

**Date:** 2026-05-28
**Status:** Design approved, pending spec review
**Surface:** `whisper collab dashboard` (Ink TUI) — Wall and Inspector modes

## Goal

Polish the dashboard for visual hierarchy, information density, and
multi-project scale. Two problems drive this work:

1. **Hierarchy/density** — state is spelled out in words (`Chain active ·
   ALIVE`) that compete with the red `STUCK` signal; phase progress is buried
   as `P2/5` text with no visual bar; label/type/phase run together in one
   undifferentiated header; log timestamps eat horizontal width.
2. **Scale** — the flat capacity model surfaces too few cards (≈3 in practice)
   for an operator running several projects at once, with no grouping by
   status. A user actively working multiple projects needs ~12 cards, grouped
   and ordered so the important work is always visible.

The redesign establishes one **status-first** visual language shared by the
Wall and Inspector.

## Non-Goals (YAGNI)

- No sparklines, no theming/config surface.
- No new keybindings.
- **Broker changes are limited to one additive, non-breaking projection.**
  This phase introduces exactly one new field on `CollabSummary` —
  `workflowCreatedAt: string | null` — so the Wall can sort by workflow kickoff
  time. The change is purely additive: a new column projected from the already-
  joined `workflows` row in `buildCollabSummary`, with no change to the
  eligible/finished row filters, no new query, no other type widening, and no
  cast change. Nullable because manual-relay collabs have no bound workflow.
  Every other broker query, type, and SQL cast stays exactly as it is today.
- No abbreviation map for workflow types (full name, dimmed).
- **No paused-workflow support anywhere in this phase — Wall or Inspector.**
  The broker dashboard pipeline does not surface paused workflows: `CollabSummary`
  lacks a `paused` `workflowStatus`
  (`packages/broker/src/storage/repositories/dashboard-repository.ts:9`), the
  eligible-collab query only selects running workflows (`:71-73`), the finished
  backfill only includes `done`/`halted`/`canceled` (`:90-93`), and
  `WorkflowSummaryRow.status` excludes `paused` (`:28-33`), with
  `listWorkflowsForCollab` casting the SQL `status` to a union that omits
  paused (`:283-288`). Surfacing paused — on the Wall OR in the Inspector
  workflow history — would require broker type, query, and cast changes. Those
  are out of scope for this presentation-only phase, so paused is deferred to a
  follow-up. Neither the Wall nor the Inspector renders a paused glyph this
  phase, and no paused-related test ships with this work.

## Color Theme (borrowed from ai-cortex)

The dashboard adopts ai-cortex's terracotta palette. A new shared module
`packages/cli/src/runtime/theme.ts` mirrors `~/Dev/ai-cortex/src/tui/theme.ts`:

```ts
export const THEME = {
  accent: "#D97757", // Claude terracotta
  ok: "green",
  warn: "yellow",
  err: "red",
  muted: "gray",
} as const;

export const AGENT_COLOR = {
  claude: "#D97757", // terracotta (signature)
  codex: "#5FB3C9",  // palette teal
} as const;
```

This replaces the current `codex=cyan` / `claude=magenta` mapping in
`dashboard-view.tsx` and all ad-hoc `"cyan"`/`"gray"`/`"red"` literals in the
dashboard renderers, which now reference `THEME` / `AGENT_COLOR` tokens.

**Borders:** switch card borders from `borderStyle="round"` to
`borderStyle="single"` (matching ai-cortex). Border color:
- normal → `THEME.muted`
- selected → `THEME.accent` (was `cyan`)
- stuck → `THEME.err`

The selection chevron and the selected card's bold header also use
`THEME.accent` instead of cyan.

## Visual Language: the Status Glyph

A single leading colored glyph is the source of truth for a card's state,
replacing verbose `Chain <state> · ALIVE` text. Each distinct terminal/lifecycle
state has its own glyph so presentation is unambiguous:

| Glyph | Color          | State | Triggered by |
|-------|----------------|-------|--------------|
| `●`   | `THEME.accent` | running          | `workflowStatus === "running"` AND not stuck |
| `⚠`   | `THEME.err`    | stuck            | running + chain `escalated`/`abandoned`, round-max reached, provider offline, mount-dead, OR `workflowStatus === "halted"` |
| `✓`   | `THEME.ok`     | done             | `workflowStatus === "done"` |
| `✖`   | `THEME.err`    | canceled         | `workflowStatus === "canceled"` |
| `◌`   | `THEME.muted`  | idle / manual    | no workflow bound (manual-relay session) |

(`paused` is deferred — see Non-Goals — and intentionally absent from this
table. The `⏸` glyph and its color binding will land with the follow-up phase
that expands the broker types/queries.)

**Resolution of prior contradiction:** `canceled` is NOT the stuck glyph. It
has its own `✖` (err color), distinct from `✓` done (ok color) and `⚠` stuck
(err color). This lets the DONE/CANCELED group render `✓` for done cards and
`✖` for canceled cards without conflicting with the stuck-glyph mapping.

The stuck glyph `⚠` covers two sub-cases: (a) `running` workflows whose chain
is escalated/abandoned, round-max reached, provider offline, or mount-dead —
these stay pinned at the front of the ACTIVE group per the stuck sub-rule; and
(b) terminal `halted` workflows, which render in the HALTED group with the same
`⚠` glyph (operator/system stopped a run before completion). `canceled` is
treated as a deliberate terminal end (✖), not stuck.

Shape carries meaning independent of color (colorblind-safe). The glyph is a
pure presentation mapping derived from existing signals (`workflowStatus`,
`chainStatus`, `rv.stuck`, mount-alive) — no new state computation; the
existing `attentionRank` and `computeLiveness` outputs already supply
everything the mapping needs.

## Wall — Grouped, Sectioned Layout

The flat `gridCapacity` × pagination model is replaced by **group-priority
allocation**. Cards are partitioned into ordered status groups; each group
renders as a labeled section header followed by a uniform grid of that group's
cards.

### Groups (render order)

1. **ACTIVE** — running workflows (`workflowStatus === "running"`). Full
   4-line cards.
2. **IDLE / MANUAL** — live sessions with no workflow. Compact 2-line cards.
3. **HALTED** — `workflowStatus === "halted"`. Compact 2-line cards with the
   `⚠` glyph. (Paused is deferred to a follow-up phase — see Non-Goals.)
4. **DONE / CANCELED** — `done` + `canceled`. Compact 2-line cards (`✓` for
   done, `✖` for canceled). Fills only remaining room.

Section header format (dim): `ACTIVE (5)` — group name + card count. A group
with zero cards renders no header.

### Sort within each group

Most-recently-kicked-off first: `CollabSummary.workflowCreatedAt` descending
(the new additive field projected in `buildCollabSummary` — see Components),
laid out left-to-right then top-to-bottom. Idle/manual sessions (no workflow,
`workflowCreatedAt === null`) fall back to `lastActivityAt` descending. A
collab with a bound workflow but a missing `workflowCreatedAt` (defensive — the
join should always supply it) also falls back to `lastActivityAt`. Because
sorting happens on summaries before per-page snapshot fetching
(`packages/cli/src/runtime/dashboard.ts:315-331`), the additive summary field
is the right place — and the only correct place — for this sort key.

**Stuck sub-rule:** a stuck-but-running workflow (escalated/round-max chain
while `workflowStatus === "running"`) stays in ACTIVE but pins to the front of
the group, ahead of non-stuck active cards, carrying its red `⚠` glyph and red
border. Attention stays loud without removing it from the active section.
Recency ordering applies among the stuck cards and among the non-stuck cards
independently.

### Priority fill / capacity

- Compute available terminal rows.
- Walk groups in priority order. Each group consumes: 1 header row + its grid
  (cards laid out at the group's card height and the shared column width).
- Stop adding groups/cards when the screen is full. **ACTIVE is never dropped
  or truncated to make room for a lower-priority group** — lower groups simply
  get whatever rows remain, and DONE/CANCELED appears only if room is left.
- Targets ~12 cards on a normal full-screen terminal. Overflow pages via
  `[ ]`; section headers repeat as needed per page.

### Full card (ACTIVE)

```
╭────────────────────────────────╮
│▸ ● mylabel        complex-bug-… │  line1: chevron · glyph · label(bold) · type(dim, truncated) · R1/3
│  P2/5 ▰▰▱▱▱  codex●  claude●     │  line2: phase progress bar + round; per-agent health dots
│  review   codex→claude  pass    │  line3: latest event (dim, aligned cols, no timestamp)
│  execute  claude→codex  -       │  line4: prior event (dim)
╰────────────────────────────────╯
```

- **line1:** selection chevron (`▸ ` / `  `), status glyph, bold label, dimmed
  workflow type (full name, `wrap="truncate"`), and `R<round>/<max>` at the end
  when a chain is present.
- **line2:** phase progress bar `▰` (filled) / `▱` (empty), width = total
  phases; filled count = current phase index. Followed by per-agent health
  dots: `●` healthy / `◐` degraded / `○` dead. Dot **color** carries health
  (`THEME.ok` / `THEME.warn` / `THEME.err`), replacing the `●(dead)` text; the
  agent **name** next to it is tinted with its `AGENT_COLOR` (claude terracotta,
  codex teal). On a narrow pane (< ~48 cols) the bar
  falls back to `P<n>/<total>` text with no bar.
- **lines 3–4:** the two latest relay events, dimmed, timestamp dropped, with
  step / route / verdict aligned into fixed-width columns (reuse `pad`).

### Full card (STUCK, in ACTIVE)

Red `⚠` glyph + red border (border already red today). The `rv.why` reason text
dominates lines 2–3 in red; event lines are suppressed — escalation is the
loudest signal.

```
╭────────────────────────────────╮
│▸ ⚠ mylabel        complex-bug-… │
│  STUCK 6m12s — round 3/3 max    │
│  reached → escalated            │
╰────────────────────────────────╯
```

### Compact card (2-line, non-active groups)

```
╭────────────────────────────────╮
│ ✓ donelabel        spec-driven… │  line1: glyph · label(bold) · type(dim, truncated)
│   P5/5 · done · 4m12s           │  line2: phase fraction · status word · elapsed
╰────────────────────────────────╯
```

### Footer

Keep the existing keybind help (dim) and append a glyph legend:
`● running  ⚠ stuck/halted  ✓ done  ✖ canceled  ◌ idle`. Group counts already
live in the section headers. (Paused is absent from the legend because it is
deferred — see Non-Goals — and not rendered anywhere this phase.)

## Inspector — same visual language

- **Header** gains the status glyph before the label, matching the Wall.
- **Timeline / Cost / Evidence tables:** align columns with fixed-width padding
  (reuse `pad` from `relay-view-state.ts`), dim secondary columns, and color
  outcomes/verdicts (`THEME.ok` for ok, `THEME.err` for fail/escalate). The
  `likelyCause` line stays `THEME.warn` `▸`.
- **Workflow history:** status colored via the same in-scope glyph map
  (running/stuck/done/canceled/idle). Paused is not rendered here this phase —
  see Non-Goals; the broker type widening it depends on is deferred.
- Tab bar (`[1 Live] …`) and section navigation are unchanged structurally; the
  active-tab marker uses `THEME.accent`.
- All Inspector color literals migrate to `THEME` / `AGENT_COLOR` tokens.

## Components & Data Flow

- **`theme.ts` (new, `packages/cli/src/runtime/`)** — `THEME` + `AGENT_COLOR`
  tokens mirroring ai-cortex. Single source for every color literal the
  dashboard renderers use.
- **`relay-view-state.ts`** — export per-agent health structurally (agent type
  + health state) instead of, or in addition to, the joined `dots` string, so
  the view can color each dot. `computeLiveness` / `buildRelayViewState` state
  logic is otherwise unchanged; the glyph mapping consumes existing fields.
- **Broker changes — exactly one additive field.**
  `packages/broker/src/storage/repositories/dashboard-repository.ts` gains a
  single additive change:
  1. `CollabSummary` (`:4-26`) adds `workflowCreatedAt: string | null`.
  2. `buildCollabSummary` (`:120-135`, `:244-263`) projects
     `w.created_at AS workflowCreatedAt` from the already-joined `workflows`
     row and includes the field in the returned object. `null` when no
     workflow is bound.

  Nothing else moves. The eligible-collab query (`:71-73`), the finished
  backfill (`:90-93`), `WorkflowSummaryRow` (`:28-33`), and the
  `listWorkflowsForCollab` SQL cast (`:283-288`) stay exactly as they are.
  `workflowStatus` is unchanged: the four Wall groups and the Inspector
  workflow history consume only today's values (`running`/`halted`/`done`/
  `canceled`) plus the no-workflow idle/manual case. Adding paused — to
  either surface — remains a follow-up that requires the broader type,
  query, and cast expansion (out of scope here).
- **`dashboard-state.ts`** — replace `WallPaneState.healthLine: string` with
  structured fields: status group, glyph key, phase progress fraction (current
  / total), per-agent health, round (cur/max), workflow type, elapsed, and the
  reformatted event lines. Rework `selectWallPage` / `buildWallState` from
  flat-capacity pagination into group-priority allocation (group partition,
  per-group recency sort, stuck-pin sub-rule, row-budget fill). Add a
  `cardKind` (`full` | `compact`) per group.
- **`dashboard-view.tsx`** — render sectioned grids (header + grid per group,
  uniform card height within a group, shared column width), the full and
  compact card variants, the progress bar with narrow-pane fallback, colored
  status glyph and agent dots, and the footer legend. `Inspector` adopts the
  glyph + aligned/colored tables.

## Error Handling / Edge Cases

- **Empty wall:** existing `no active collabs (last 30m)` message preserved
  when every group is empty.
- **Narrow pane (< ~48 cols):** progress bar collapses to text; all `Text`
  stays `wrap="truncate"` so long labels/types never wrap the layout.
- **Very short terminal:** at minimum show the ACTIVE header + as many active
  cards as fit; never render a header with zero cards.
- **No chain / manual relay:** omit `R<round>/<max>` and the progress bar;
  card shows `◌` idle glyph.
- **Malformed/missing timestamps:** reuse existing `elapsedSince` guards (`—`
  on unparseable) so recency sort and elapsed never render `NaN`.
- **Group overflow within a page:** cards beyond the row budget for a group
  spill to the next page in the same group order; headers repeat.
- **Compact-card glyphs by group:** HALTED renders compact cards with `⚠`
  (err); DONE/CANCELED renders compact cards with `✓` (ok) for done and `✖`
  (err) for canceled — never `⚠`. Only the running-but-stuck case pins inside
  ACTIVE as a full card with `⚠`. This keeps the glyph mapping unambiguous
  across full and compact variants.

## Testing

- **Glyph mapping** — unit test the state→glyph function across the five
  in-scope states: `●` running, `⚠` stuck (each stuck cause: chain escalated,
  chain abandoned, round-max, provider offline, mount-dead, `workflowStatus`
  halted), `✓` done, `✖` canceled, `◌` idle/manual. Each glyph is asserted
  with its `THEME` color token. No paused-glyph test ships with this phase —
  paused is deferred along with the broker type/query changes that would make
  it reachable.
- **Grouping & sort** — `selectWallPage`/allocation: four-group partition
  order (ACTIVE → IDLE/MANUAL → HALTED → DONE/CANCELED), recency sort within
  group using `workflowCreatedAt` descending, idle/manual + null-
  `workflowCreatedAt` `lastActivityAt` fallback, stuck-pin to front of ACTIVE,
  priority fill (ACTIVE never dropped for DONE), done-only-if-room, overflow
  paging. Paused summaries (if ever present) are excluded — assert they do
  not appear in any Wall group this phase.
- **Broker projection** — a focused test for `buildCollabSummary`
  asserts the new `workflowCreatedAt` field is the joined workflow's
  `created_at` for a workflow-bound collab and `null` for a manual-relay
  collab, with no other field shape change.
- **Progress bar** — filled/empty counts vs phase index/total; narrow-pane text
  fallback.
- **Per-agent dots** — healthy/degraded/dead → glyph + `THEME` health color;
  agent name tinted with `AGENT_COLOR` (claude terracotta, codex teal).
- **Theme tokens** — assert renderers reference `THEME`/`AGENT_COLOR` (no stray
  `cyan`/`magenta` literals); border color resolves to muted/accent/err for
  normal/selected/stuck.
- **Rendering** — snapshot/structural tests for full card, compact card, stuck
  card, section headers with counts, footer legend; normalize newlines /
  tolerant matching for wrapped terminal output (panels wrap at terminal
  width).
- **Inspector** — column alignment and outcome/verdict coloring; header glyph.

## Open Risks

- Mixed card heights across groups: mitigated by rendering each group as its
  own grid (uniform height within a group) rather than one global grid.
- Row-budget allocation must account for section-header rows and border rows;
  off-by-one here shows as a clipped bottom card — covered by allocation tests.

## Deferred Follow-ups

- **Paused workflows on the Wall AND in the Inspector workflow history.**
  Requires widening `CollabSummary.workflowStatus` to include `paused`
  (`packages/broker/src/storage/repositories/dashboard-repository.ts:9`),
  broadening the eligible-collab query (`:71-73`), adding paused to the
  finished backfill (`:90-93`), widening `WorkflowSummaryRow.status` (`:28-33`),
  and adjusting the `listWorkflowsForCollab` SQL cast (`:283-288`). Once those
  land, the `⏸` glyph (in `THEME.warn`) is wired into the glyph mapping and
  legend, a PAUSED group (compact cards) slots in between HALTED and
  DONE/CANCELED on the Wall using the same allocation machinery introduced
  here, and the Inspector workflow history starts rendering paused rows with
  the same glyph. The corresponding paused-glyph test (Wall + Inspector
  contexts) ships at that point. Tracked separately so this phase remains
  presentation-only.
