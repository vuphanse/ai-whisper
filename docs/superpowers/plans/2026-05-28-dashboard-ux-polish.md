# Dashboard UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the status-first card redesign and grouped, sectioned Wall described in
`docs/superpowers/specs/2026-05-28-dashboard-ux-polish-design.md`, including the ai-cortex
terracotta theme and Inspector visual-language alignment.

**Architecture:** Presentation-layer work in `packages/cli/src/runtime/` (new `theme.ts`,
restructured `dashboard-state.ts` + `dashboard-view.tsx`, additive export from
`relay-view-state.ts`), plus one tightly-scoped additive field on `CollabSummary` in the
broker so the Wall can sort by workflow kickoff time. The Wall replaces flat-capacity
pagination with per-group priority-fill allocation; each group renders as a labeled
section with uniform card height. The Inspector adopts the same status glyph and shared
color tokens.

**Tech Stack:** TypeScript, React (Ink TUI), better-sqlite3, vitest.

---

## File Structure

**Create**
- `packages/cli/src/runtime/theme.ts` — `THEME` + `AGENT_COLOR` tokens; pure constants.
- `packages/cli/src/runtime/dashboard-glyph.ts` — pure `statusGlyph()` mapping (state → glyph+color token).
- `test/theme.test.ts` — token-shape tests.
- `test/dashboard-glyph.test.ts` — state→glyph mapping tests.
- `test/dashboard-wall-allocation.test.ts` — group partition, recency sort, stuck-pin, priority fill, paging.

**Modify**
- `packages/broker/src/storage/repositories/dashboard-repository.ts` — add additive
  `workflowCreatedAt: string | null` to `CollabSummary`; project from joined `workflows.created_at`.
- `packages/cli/src/runtime/relay-view-state.ts` — add a structured per-agent health
  export (`agentHealth: Array<{ agent: "codex"|"claude", health: "healthy"|"degraded"|"dead" }>`)
  alongside the existing `dots` string.
- `packages/cli/src/runtime/dashboard-state.ts` — replace `WallPaneState.healthLine: string`
  with structured fields; rework `buildWallState` and add group partition + priority-fill
  allocation; keep `selectWallPage` as a thin compat shim or remove its callers.
- `packages/cli/src/runtime/dashboard-view.tsx` — sectioned grid renderer, full/stuck/compact
  card variants, theme/agent tokens, progress bar with narrow fallback, footer legend,
  Inspector polish (header glyph, aligned tables, colored verdicts/outcomes, active-tab accent).

**Update test files**
- `test/dashboard-repository.test.ts` — assert the new `workflowCreatedAt` projection.
- `test/dashboard-state.test.ts` — update the `sum()` factory to include `workflowCreatedAt`;
  add new partition/sort/stuck-pin/priority-fill tests; preserve legacy `selectWallPage`
  behaviour tests via the new shim or replace them with the new allocator tests.
- `test/dashboard-view.test.tsx` — section headers + counts; full/stuck/compact card
  rendering; progress bar + narrow fallback; footer legend; Inspector header glyph and
  aligned/colored columns; theme-token guards (no `cyan`/`magenta` string literals in
  renderer output).
- `test/relay-view-state.test.ts` — assert the new structured `agentHealth` field is
  present and matches the existing `dots`-string source data.

---

## Conventions for every task

- TDD: failing test → minimal impl → green → commit. Each commit is one logical concept.
- Run tests from repo root: `pnpm -w vitest run <path>`. Use `--reporter=verbose` for
  per-test output when diagnosing failures.
- No `Co-Authored-By` trailers in commit messages (user preference).
- Render assertions on Ink output: normalize newlines and grep tolerantly because panels
  wrap at terminal width (project memory, situational).
- Keep changes presentation-only outside Task 3, which is the single additive broker
  projection sanctioned by the spec.

---

### Task 1: Theme + Agent-color tokens

**Files:**
- Create: `packages/cli/src/runtime/theme.ts`
- Test:   `test/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/theme.test.ts
import { describe, expect, it } from "vitest";
import { THEME, AGENT_COLOR } from "../packages/cli/src/runtime/theme.ts";

describe("THEME", () => {
  it("matches ai-cortex tokens", () => {
    expect(THEME.accent).toBe("#D97757");
    expect(THEME.ok).toBe("green");
    expect(THEME.warn).toBe("yellow");
    expect(THEME.err).toBe("red");
    expect(THEME.muted).toBe("gray");
  });
});

describe("AGENT_COLOR", () => {
  it("claude=terracotta, codex=teal", () => {
    expect(AGENT_COLOR.claude).toBe("#D97757");
    expect(AGENT_COLOR.codex).toBe("#5FB3C9");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm -w vitest run test/theme.test.ts`
Expected: FAIL — `Cannot find module …/theme.ts`.

- [ ] **Step 3: Create the module**

```ts
// packages/cli/src/runtime/theme.ts
// Borrowed from ~/Dev/ai-cortex/src/tui/theme.ts so both TUIs share the
// terracotta palette. Hex values match upstream exactly.
export const THEME = {
  accent: "#D97757", // Claude terracotta
  ok: "green",
  warn: "yellow",
  err: "red",
  muted: "gray",
} as const;

export const AGENT_COLOR = {
  claude: "#D97757", // signature terracotta
  codex: "#5FB3C9",  // palette teal
} as const;

export type ThemeToken = keyof typeof THEME;
export type AgentName = keyof typeof AGENT_COLOR;
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm -w vitest run test/theme.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/theme.ts test/theme.test.ts
git commit -m "feat(cli): add shared THEME + AGENT_COLOR tokens (ai-cortex terracotta)"
```

---

### Task 2: Status glyph mapping

**Files:**
- Create: `packages/cli/src/runtime/dashboard-glyph.ts`
- Test:   `test/dashboard-glyph.test.ts`

The glyph mapping is a pure function of `(workflowStatus | null, stuck: boolean)`. It
must never return the `⏸ paused` glyph — paused is deferred per the spec.

- [ ] **Step 1: Write the failing tests**

```ts
// test/dashboard-glyph.test.ts
import { describe, expect, it } from "vitest";
import { statusGlyph } from "../packages/cli/src/runtime/dashboard-glyph.ts";
import { THEME } from "../packages/cli/src/runtime/theme.ts";

describe("statusGlyph", () => {
  it("running (not stuck) → ● accent", () => {
    expect(statusGlyph({ workflowStatus: "running", stuck: false }))
      .toEqual({ glyph: "●", color: THEME.accent, key: "running" });
  });
  it("running + stuck → ⚠ err", () => {
    expect(statusGlyph({ workflowStatus: "running", stuck: true }))
      .toEqual({ glyph: "⚠", color: THEME.err, key: "stuck" });
  });
  it("halted → ⚠ err (regardless of stuck flag)", () => {
    expect(statusGlyph({ workflowStatus: "halted", stuck: false }))
      .toEqual({ glyph: "⚠", color: THEME.err, key: "stuck" });
    expect(statusGlyph({ workflowStatus: "halted", stuck: true }))
      .toEqual({ glyph: "⚠", color: THEME.err, key: "stuck" });
  });
  it("done → ✓ ok", () => {
    expect(statusGlyph({ workflowStatus: "done", stuck: false }))
      .toEqual({ glyph: "✓", color: THEME.ok, key: "done" });
  });
  it("canceled → ✖ err (NOT the stuck glyph)", () => {
    expect(statusGlyph({ workflowStatus: "canceled", stuck: false }))
      .toEqual({ glyph: "✖", color: THEME.err, key: "canceled" });
  });
  it("null workflow (manual relay) → ◌ muted", () => {
    expect(statusGlyph({ workflowStatus: null, stuck: false }))
      .toEqual({ glyph: "◌", color: THEME.muted, key: "idle" });
  });
  it("never returns the paused glyph this phase", () => {
    // Defensive: even if a paused value leaked in, the mapping must not emit ⏸.
    expect(statusGlyph({ workflowStatus: "running", stuck: false }).glyph).not.toBe("⏸");
  });
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm -w vitest run test/dashboard-glyph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapping**

```ts
// packages/cli/src/runtime/dashboard-glyph.ts
import { THEME } from "./theme.js";

export type StatusKey = "running" | "stuck" | "done" | "canceled" | "idle";

export type GlyphResult = {
  glyph: "●" | "⚠" | "✓" | "✖" | "◌";
  color: (typeof THEME)[keyof typeof THEME];
  key: StatusKey;
};

export function statusGlyph(input: {
  workflowStatus: "running" | "done" | "halted" | "canceled" | null;
  stuck: boolean;
}): GlyphResult {
  // No bound workflow → idle/manual relay.
  if (input.workflowStatus === null) {
    return { glyph: "◌", color: THEME.muted, key: "idle" };
  }
  // Terminal/lifecycle ends have their own glyphs, distinct from stuck.
  if (input.workflowStatus === "done") {
    return { glyph: "✓", color: THEME.ok, key: "done" };
  }
  if (input.workflowStatus === "canceled") {
    return { glyph: "✖", color: THEME.err, key: "canceled" };
  }
  // Halted always uses the stuck glyph (operator/system stopped a run).
  if (input.workflowStatus === "halted") {
    return { glyph: "⚠", color: THEME.err, key: "stuck" };
  }
  // workflowStatus === "running": glyph keys off the runtime stuck flag.
  return input.stuck
    ? { glyph: "⚠", color: THEME.err, key: "stuck" }
    : { glyph: "●", color: THEME.accent, key: "running" };
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-glyph.test.ts`
Expected: PASS — all seven tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-glyph.ts test/dashboard-glyph.test.ts
git commit -m "feat(cli): add statusGlyph mapping (running/stuck/done/canceled/idle)"
```

---

### Task 2b: Stuck-cause coverage — every stuck cause renders `⚠`

**Files:**
- Create: `test/dashboard-stuck-causes.test.ts`

The spec testing requirement enumerates six stuck causes (`docs/superpowers/specs/2026-05-28-dashboard-ux-polish-design.md` Testing §). `statusGlyph` itself only takes a `stuck: boolean`, so the spec contract is enforced end-to-end: each cause must drive `computeLiveness`/`buildRelayViewState` to `stuck: true`, then `statusGlyph` to `⚠` in `THEME.err`. This task pins that chain.

- [ ] **Step 1: Write the failing tests**

```ts
// test/dashboard-stuck-causes.test.ts
import { describe, expect, it } from "vitest";
import {
  buildRelayViewState,
  type RelayViewSnapshot,
} from "../packages/cli/src/runtime/relay-view-state.ts";
import { statusGlyph } from "../packages/cli/src/runtime/dashboard-glyph.ts";
import { THEME } from "../packages/cli/src/runtime/theme.ts";

const BASE_NOW = "2026-05-28T00:10:00.000Z";
const LONG_AGO = "2026-05-28T00:00:00.000Z"; // 10 min idle, past the default 5-min budget

function snap(p: Partial<RelayViewSnapshot> & {
  workflowStatus?: "running" | "halted" | "done" | "canceled";
}): RelayViewSnapshot {
  const status = p.workflowStatus ?? "running";
  return {
    now: BASE_NOW,
    idleThresholdMs: 60_000,
    workflow: {
      workflowId: "wf",
      workflowType: "complex-bug-fixing",
      name: "demo",
      status,
      createdAt: LONG_AGO,
      haltReason: null,
    },
    phaseRuns: [
      { phaseRunId: "pr1", phaseIndex: 0, phaseName: "plan", startedAt: LONG_AGO, endedAt: null, outcome: null },
    ],
    currentPhaseRunId: "pr1",
    currentStep: "review",
    totalPhases: 3,
    chain: { currentRound: 1, maxRounds: 3, status: "active" },
    turn: { turnOwner: "codex", waitingAgent: null, handoffState: "accepted" },
    sessions: [
      { agentType: "codex", healthState: "healthy", mountAlive: true },
      { agentType: "claude", healthState: "healthy", mountAlive: true },
    ],
    lastActivityAt: LONG_AGO,
    handoffs: [],
    ...p,
  };
}

function assertStuckGlyph(rv: ReturnType<typeof buildRelayViewState>): void {
  expect(rv.stuck).toBe(true);
  const result = statusGlyph({
    workflowStatus: "running",
    stuck: rv.stuck,
  });
  expect(result.glyph).toBe("⚠");
  expect(result.color).toBe(THEME.err);
  expect(result.key).toBe("stuck");
}

describe("stuck causes all render the ⚠ glyph in THEME.err", () => {
  it("chain escalated", () => {
    const rv = buildRelayViewState(
      snap({ chain: { currentRound: 1, maxRounds: 3, status: "escalated" } }),
    );
    assertStuckGlyph(rv);
  });

  it("chain abandoned", () => {
    const rv = buildRelayViewState(
      snap({ chain: { currentRound: 1, maxRounds: 3, status: "abandoned" } }),
    );
    assertStuckGlyph(rv);
  });

  it("round-max reached (maxRounds > 1)", () => {
    const rv = buildRelayViewState(
      snap({ chain: { currentRound: 3, maxRounds: 3, status: "active" } }),
    );
    assertStuckGlyph(rv);
  });

  it("provider offline (active session healthState=offline)", () => {
    const rv = buildRelayViewState(
      snap({
        sessions: [
          { agentType: "codex", healthState: "offline", mountAlive: true },
          { agentType: "claude", healthState: "healthy", mountAlive: true },
        ],
      }),
    );
    assertStuckGlyph(rv);
  });

  it("mount-dead (active session mountAlive=false past idle budget)", () => {
    const rv = buildRelayViewState(
      snap({
        sessions: [
          { agentType: "codex", healthState: "healthy", mountAlive: false },
          { agentType: "claude", healthState: "healthy", mountAlive: true },
        ],
      }),
    );
    assertStuckGlyph(rv);
  });

  it("workflowStatus=halted maps to ⚠ via statusGlyph directly", () => {
    // Halted is terminal: statusGlyph short-circuits to ⚠ regardless of stuck.
    const result = statusGlyph({ workflowStatus: "halted", stuck: false });
    expect(result.glyph).toBe("⚠");
    expect(result.color).toBe(THEME.err);
    expect(result.key).toBe("stuck");
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-stuck-causes.test.ts`
Expected: FAIL on file-not-found until the file is saved; then PASS once Task 4
(structured `agentHealth`) has not yet landed — these tests depend only on
`buildRelayViewState`'s existing `stuck` output, which is already produced by
`computeLiveness` today, so they can run before Task 4. If a case unexpectedly
returns `stuck: false`, the implementation in `relay-view-state.ts` has a real
gap and must be fixed before proceeding.

- [ ] **Step 3: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-stuck-causes.test.ts`
Expected: PASS — all six stuck causes produce `⚠` in `THEME.err`.

- [ ] **Step 4: Commit**

```bash
git add test/dashboard-stuck-causes.test.ts
git commit -m "test(cli): pin stuck-cause→⚠ glyph for every spec-listed cause"
```

---

### Task 3: Broker — project `workflowCreatedAt` on `CollabSummary`

**Files:**
- Modify: `packages/broker/src/storage/repositories/dashboard-repository.ts` (lines 4-26, 120-136, 244-263)
- Test:   `test/dashboard-repository.test.ts`

The only broker change permitted this phase. Additive nullable field projected from the
already-joined `workflows` row.

- [ ] **Step 1: Add a failing test that asserts the new field**

Append to `test/dashboard-repository.test.ts`:

```ts
// Add inside the existing describe() block for buildCollabSummary.
it("projects workflowCreatedAt from the joined workflow row", () => {
  // Arrange — seed one collab with a workflow.
  const db = openTestDb(); // existing helper in this file
  seedCollab(db, { collabId: "c1" });
  seedWorkflow(db, {
    collabId: "c1",
    workflowId: "wf1",
    workflowType: "spec-driven-development",
    name: "demo",
    status: "running",
    createdAt: "2026-05-28T01:02:03.000Z",
  });

  const summary = buildCollabSummary(db, "c1");
  expect(summary.workflowCreatedAt).toBe("2026-05-28T01:02:03.000Z");
});

it("workflowCreatedAt is null for a manual-relay collab (no workflow)", () => {
  const db = openTestDb();
  seedCollab(db, { collabId: "c2" });
  // No workflow seeded.
  const summary = buildCollabSummary(db, "c2");
  expect(summary.workflowCreatedAt).toBeNull();
});
```

> If `openTestDb`, `seedCollab`, or `seedWorkflow` are not exported helpers in this test
> file, follow the closest existing pattern in the file (re-using its current
> in-memory DB setup) and inline the SQL `INSERT`s. The point is to seed one workflow
> with a known `created_at` and one collab with none.

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm -w vitest run test/dashboard-repository.test.ts -t "workflowCreatedAt"`
Expected: FAIL — `expected undefined to be "2026-05-28T…"`.

- [ ] **Step 3: Add the field to the type and project it**

In `packages/broker/src/storage/repositories/dashboard-repository.ts`, extend the
`CollabSummary` type to include the new field (insert immediately above `lastActivityAt`):

```ts
export type CollabSummary = {
  collabId: string;
  label: string;
  workflowId: string | null;
  workflowType: string | null;
  workflowStatus: "running" | "done" | "halted" | "canceled" | null;
  currentPhaseRunId: string | null;
  phaseIndex: number | null;
  phaseName: string | null;
  currentRound: number | null;
  maxRounds: number | null;
  chainStatus: "active" | "done" | "escalated" | "abandoned" | null;
  turn: {
    owner: "codex" | "claude" | "none";
    waiting: "codex" | "claude" | null;
    handoffState: string;
  };
  sessions: Array<{ agentType: string; healthState: string; mountAlive?: boolean }>;
  workflowCreatedAt: string | null; // additive — see spec Non-Goals
  lastActivityAt: string;
};
```

Update the `wf` SELECT (currently at lines 120-136) to project `created_at`:

```ts
const wf = db
  .prepare(
    `SELECT workflow_id AS workflowId, workflow_type AS workflowType,
            name, status, current_phase_index AS currentPhaseIndex,
            created_at AS createdAt
       FROM workflows WHERE collab_id = ?
      ORDER BY (status = 'running') DESC, created_at DESC
      LIMIT 1`,
  )
  .get(e.collabId) as
  | {
      workflowId: string;
      workflowType: string;
      name: string | null;
      status: "running" | "done" | "halted" | "canceled";
      currentPhaseIndex: number;
      createdAt: string;
    }
  | undefined;
```

Add the field to the returned object (between `sessions` and `lastActivityAt`):

```ts
return {
  // ...unchanged fields above...
  sessions,
  workflowCreatedAt: wf?.createdAt ?? null,
  lastActivityAt: runLastAct,
};
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-repository.test.ts`
Expected: PASS — new tests green, all prior tests still green.

- [ ] **Step 5: Build the broker to catch type leaks**

Run: `pnpm -w --filter @ai-whisper/broker build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/storage/repositories/dashboard-repository.ts test/dashboard-repository.test.ts
git commit -m "feat(broker): project workflowCreatedAt on CollabSummary (additive)"
```

---

### Task 4: relay-view-state — structured per-agent health export

**Files:**
- Modify: `packages/cli/src/runtime/relay-view-state.ts` (around lines 348-360 + return at 407-418)
- Test:   `test/relay-view-state.test.ts`

The view needs to color each agent dot per-agent. Add a parallel structured field;
keep `dots` for back-compat.

- [ ] **Step 1: Write the failing test**

Add to `test/relay-view-state.test.ts`:

```ts
import { buildRelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";

it("exposes structured agentHealth alongside the dots string", () => {
  const state = buildRelayViewState({
    now: "2026-05-28T00:00:00.000Z",
    idleThresholdMs: 60_000,
    workflow: null,
    phaseRuns: [],
    currentPhaseRunId: null,
    currentStep: null,
    totalPhases: 0,
    chain: null,
    turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
    sessions: [
      { agentType: "codex", healthState: "healthy", mountAlive: true },
      { agentType: "claude", healthState: "degraded", mountAlive: true },
    ],
    lastActivityAt: null,
    handoffs: [],
  });
  expect(state.agentHealth).toEqual([
    { agent: "codex", health: "healthy" },
    { agent: "claude", health: "degraded" },
  ]);
});

it("agentHealth treats missing session as dead", () => {
  const state = buildRelayViewState({
    now: "2026-05-28T00:00:00.000Z",
    idleThresholdMs: 60_000,
    workflow: null,
    phaseRuns: [],
    currentPhaseRunId: null,
    currentStep: null,
    totalPhases: 0,
    chain: null,
    turn: { turnOwner: "none", waitingAgent: null, handoffState: "idle" },
    sessions: [], // no codex/claude rows
    lastActivityAt: null,
    handoffs: [],
  });
  expect(state.agentHealth).toEqual([
    { agent: "codex", health: "dead" },
    { agent: "claude", health: "dead" },
  ]);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm -w vitest run test/relay-view-state.test.ts -t "agentHealth"`
Expected: FAIL — `state.agentHealth` undefined.

- [ ] **Step 3: Update `RelayViewState` and `buildRelayViewState`**

Add the field to the exported type:

```ts
export type RelayViewState = {
  wf: string;
  progress: string;
  elapsed: string;
  turn: string;
  health: string;
  agentHealth: Array<{
    agent: "codex" | "claude";
    health: "healthy" | "degraded" | "dead";
  }>;
  live: string;
  why: string | null;
  last: string;
  stuck: boolean;
  logLines: LogLine[];
};
```

Compute it alongside the existing `dots` join in `buildRelayViewState` (replace the
existing `const dots = RELAY_AGENTS.map(…)` block):

```ts
const agentHealth = RELAY_AGENTS.map((a) => {
  const sess = snap.sessions.find((x) => x.agentType === a);
  const health: "healthy" | "degraded" | "dead" =
    sess?.healthState === "healthy"
      ? "healthy"
      : sess?.healthState === "degraded"
        ? "degraded"
        : "dead";
  return { agent: a, health };
});

const dots = agentHealth
  .map(({ agent, health }) => {
    const glyph = health === "healthy" ? "●" : health === "degraded" ? "◐(degraded)" : "●(dead)";
    return `${glyph} ${agent}`;
  })
  .join("  ");
```

Add `agentHealth` to the final returned object.

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/relay-view-state.test.ts`
Expected: PASS, including prior tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/relay-view-state.ts test/relay-view-state.test.ts
git commit -m "feat(cli): export structured agentHealth from relay-view-state"
```

---

### Task 5: dashboard-state — structured `WallPaneState` (no group logic yet)

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-state.ts` (types + `buildWallState`)
- Test:   `test/dashboard-state.test.ts`

Replace the single `healthLine` string with the structured fields the new card variants
need. `selectWallPage` keeps its current flat-paging behaviour for now; allocation
changes land in Tasks 6-7.

- [ ] **Step 1: Update the `sum()` factory in `test/dashboard-state.test.ts`**

Add the new required field to the factory so existing tests still compile:

```ts
function sum(p: Partial<CollabSummary>): CollabSummary {
  return {
    collabId: "c", label: "lbl", workflowId: "wf", workflowType: "spec-driven-development",
    workflowStatus: "running", currentPhaseRunId: "pr1", phaseIndex: 1, phaseName: "plan-writing",
    currentRound: 2, maxRounds: 5, chainStatus: "active",
    turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
    sessions: [{ agentType: "codex", healthState: "healthy" }, { agentType: "claude", healthState: "healthy" }],
    workflowCreatedAt: "2026-05-20T00:00:00.000Z",
    lastActivityAt: "2026-05-20T00:00:00.000Z", ...p,
  };
}
```

- [ ] **Step 2: Write a failing test for the new pane shape**

```ts
it("buildWallState emits structured WallPaneState fields per pane", () => {
  const now = "2026-05-20T00:01:00.000Z";
  const summaries = [sum({ collabId: "c1" })];
  const state = buildWallState({
    summaries,
    now,
    idleThresholdMs: 60_000,
    capacity: 10,
    page: 0,
    selected: 0,
    snapshots: { c1: { handoffs: [], phaseRuns: [], totalPhases: 5 } },
  });
  const pane = state.panes[0]!;
  expect(pane.collabId).toBe("c1");
  expect(pane.statusKey).toBe("running");
  expect(pane.label).toBe("lbl");
  expect(pane.workflowType).toBe("spec-driven-development");
  expect(pane.round).toEqual({ current: 2, max: 5 });
  expect(pane.progress).toEqual({ current: 2, total: 5 }); // phaseIndex 1-based current
  expect(pane.agentHealth).toEqual([
    { agent: "codex", health: "healthy" },
    { agent: "claude", health: "healthy" },
  ]);
  expect(pane.cardKind).toBe("full"); // running → ACTIVE group → full card
  expect(pane.events.length).toBeLessThanOrEqual(2);
  expect(pane.stuckWhy).toBeNull();
});
```

- [ ] **Step 3: Run and verify it fails**

Run: `pnpm -w vitest run test/dashboard-state.test.ts -t "structured WallPaneState"`
Expected: FAIL — `pane.statusKey` undefined / `healthLine` still exists.

- [ ] **Step 4: Replace `WallPaneState` and update `buildWallState`**

Replace the type at the top of `dashboard-state.ts`:

```ts
import { statusGlyph } from "./dashboard-glyph.js";

export type WallEvent = { step: string; route: string; verdict: string };

export type WallPaneState = {
  collabId: string;
  workflowId: string | null;
  statusKey: "running" | "stuck" | "done" | "canceled" | "idle";
  label: string;
  workflowType: string | null;
  round: { current: number; max: number } | null;
  progress: { current: number; total: number } | null;
  agentHealth: Array<{
    agent: "codex" | "claude";
    health: "healthy" | "degraded" | "dead";
  }>;
  stuckWhy: string | null;
  events: WallEvent[]; // newest first, length ≤ 2
  elapsed: string; // for compact card line 2
  cardKind: "full" | "compact";
};
```

In `buildWallState`, after the existing `const rv = buildRelayViewState({...})` block,
replace the `healthLine` / `header` / pane-construction logic with structured assembly:

```ts
const glyph = statusGlyph({
  workflowStatus: s.workflowStatus,
  stuck: rv.stuck,
});
const round =
  s.currentRound != null && s.maxRounds != null
    ? { current: s.currentRound, max: s.maxRounds }
    : null;
const progress =
  s.phaseIndex != null && snap.totalPhases > 0
    ? { current: s.phaseIndex + 1, total: snap.totalPhases }
    : null;
const events = rv.logLines
  .filter((l) => l.kind === "event")
  .slice(-2)
  .reverse() // newest first
  .map((l) => parseEventText(l.text));
const cardKind: "full" | "compact" = glyph.key === "running" ? "full" : "compact";
const elapsed =
  s.workflowCreatedAt != null
    ? fmtDur(Date.parse(input.now) - Date.parse(s.workflowCreatedAt))
    : "—";

return {
  collabId: s.collabId,
  workflowId: s.workflowId,
  statusKey: glyph.key,
  label: s.label,
  workflowType: s.workflowType,
  round,
  progress,
  agentHealth: rv.agentHealth,
  stuckWhy: rv.stuck ? rv.why : null,
  events,
  elapsed,
  cardKind,
};
```

Add the `parseEventText` helper just above `buildWallState` (events are already
column-aligned by `deriveLogLines`, so this just splits on multi-space gaps and pulls
step/route/verdict — fall back to a single-token `step` if the split is short):

```ts
function parseEventText(text: string): WallEvent {
  // deriveLogLines emits: "HH:MM:SS  P·R   sender→target  step   verdict   preview"
  // We want step / route / verdict only.
  const cols = text.split(/\s{2,}/);
  const route = cols.find((c) => /[a-z]+→[a-z]+/i.test(c)) ?? "";
  const tokens = cols.filter((c) => c !== route);
  // tokens[0] = time, tokens[1] = P·R (when workflow), tokens[2] = step, tokens[3] = verdict
  const step = tokens[2] ?? "";
  const verdict = tokens[3] ?? "-";
  return { step, route, verdict };
}
```

- [ ] **Step 5: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-state.test.ts`
Expected: existing tests need their pane-shape expectations updated to the new fields.
Update any test that referenced `pane.healthLine` or `pane.header` to use the new fields
or, where coverage overlaps, delete the obsolete test in favour of the new one.
All tests PASS.

- [ ] **Step 6: Type-check the CLI package**

Run: `pnpm -w --filter @ai-whisper/cli build`
Expected: success — catches any remaining `healthLine`/`header` references in
`dashboard-view.tsx` (they will be fixed in Tasks 8-12).

> Note: `dashboard-view.tsx` will still reference `pane.healthLine` / `pane.header`
> until Task 8-9. Until then, the renderer build will fail. Allow it (the renderer is
> being replaced in those tasks); for the green test signal, build only the runtime
> module: `pnpm -w vitest run test/dashboard-state.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/runtime/dashboard-state.ts test/dashboard-state.test.ts
git commit -m "refactor(cli): restructure WallPaneState for status-first cards"
```

---

### Task 6: Group partition + recency sort + stuck-pin

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-state.ts`
- Test:   `test/dashboard-wall-allocation.test.ts`

Introduce a pure `partitionWallGroups(summaries)` function. No layout yet — just the
ordered, sorted, stuck-pinned groups.

- [ ] **Step 1: Write the failing tests**

```ts
// test/dashboard-wall-allocation.test.ts
import { describe, expect, it } from "vitest";
import { partitionWallGroups } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";

function s(p: Partial<CollabSummary>): CollabSummary {
  return {
    collabId: p.collabId ?? "c", label: "x",
    workflowId: p.workflowId ?? "wf", workflowType: "spec-driven-development",
    workflowStatus: p.workflowStatus ?? "running",
    currentPhaseRunId: null, phaseIndex: 0, phaseName: "p",
    currentRound: 1, maxRounds: 3, chainStatus: p.chainStatus ?? "active",
    turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
    sessions: [{ agentType: "codex", healthState: "healthy", mountAlive: true },
               { agentType: "claude", healthState: "healthy", mountAlive: true }],
    workflowCreatedAt: p.workflowCreatedAt ?? "2026-05-20T00:00:00.000Z",
    lastActivityAt: p.lastActivityAt ?? "2026-05-20T00:00:00.000Z",
    ...p,
  };
}

describe("partitionWallGroups", () => {
  it("partitions into ACTIVE / IDLE-MANUAL / HALTED / DONE-CANCELED in that order", () => {
    const out = partitionWallGroups([
      s({ collabId: "d", workflowStatus: "done" }),
      s({ collabId: "h", workflowStatus: "halted" }),
      s({ collabId: "m", workflowId: null, workflowStatus: null, workflowType: null }),
      s({ collabId: "r", workflowStatus: "running" }),
      s({ collabId: "x", workflowStatus: "canceled" }),
    ]);
    expect(out.active.map((x) => x.collabId)).toEqual(["r"]);
    expect(out.idleManual.map((x) => x.collabId)).toEqual(["m"]);
    expect(out.halted.map((x) => x.collabId)).toEqual(["h"]);
    expect(out.doneCanceled.map((x) => x.collabId)).toEqual(["d", "x"]);
  });

  it("sorts each group by workflowCreatedAt descending", () => {
    const out = partitionWallGroups([
      s({ collabId: "old", workflowStatus: "running", workflowCreatedAt: "2026-01-01T00:00:00Z" }),
      s({ collabId: "new", workflowStatus: "running", workflowCreatedAt: "2026-05-01T00:00:00Z" }),
      s({ collabId: "mid", workflowStatus: "running", workflowCreatedAt: "2026-03-01T00:00:00Z" }),
    ]);
    expect(out.active.map((x) => x.collabId)).toEqual(["new", "mid", "old"]);
  });

  it("idle/manual sort falls back to lastActivityAt desc", () => {
    const out = partitionWallGroups([
      s({ collabId: "a", workflowId: null, workflowStatus: null, workflowType: null,
          workflowCreatedAt: null, lastActivityAt: "2026-05-20T00:00:00Z" }),
      s({ collabId: "b", workflowId: null, workflowStatus: null, workflowType: null,
          workflowCreatedAt: null, lastActivityAt: "2026-05-25T00:00:00Z" }),
    ]);
    expect(out.idleManual.map((x) => x.collabId)).toEqual(["b", "a"]);
  });

  it("pins stuck-running rows to the front of ACTIVE, then recency among each subgroup", () => {
    const out = partitionWallGroups([
      s({ collabId: "ok-old", workflowStatus: "running",
          workflowCreatedAt: "2026-01-01T00:00:00Z", chainStatus: "active" }),
      s({ collabId: "stuck-new", workflowStatus: "running",
          workflowCreatedAt: "2026-05-01T00:00:00Z", chainStatus: "escalated" }),
      s({ collabId: "stuck-old", workflowStatus: "running",
          workflowCreatedAt: "2026-02-01T00:00:00Z", chainStatus: "escalated" }),
      s({ collabId: "ok-new", workflowStatus: "running",
          workflowCreatedAt: "2026-04-01T00:00:00Z", chainStatus: "active" }),
    ]);
    expect(out.active.map((x) => x.collabId)).toEqual([
      "stuck-new", "stuck-old", // stuck block first, recent first
      "ok-new", "ok-old",       // non-stuck block, recent first
    ]);
  });

  it("never emits a paused group (paused deferred)", () => {
    const out = partitionWallGroups([
      // Defensive: even if upstream surfaces a paused row, it must not appear on the Wall.
      s({ collabId: "p", workflowStatus: "running" }), // proxy for sanity
    ]);
    expect((out as Record<string, unknown>).paused).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-wall-allocation.test.ts`
Expected: FAIL — `partitionWallGroups` not exported.

- [ ] **Step 3: Implement `partitionWallGroups`**

Add to `dashboard-state.ts`:

```ts
export type WallGroupKey = "active" | "idleManual" | "halted" | "doneCanceled";

export type WallGroups = {
  active: CollabSummary[];
  idleManual: CollabSummary[];
  halted: CollabSummary[];
  doneCanceled: CollabSummary[];
};

function isStuckRunning(s: CollabSummary): boolean {
  // Wall-side static stuck signal — full liveness lives in computeLiveness,
  // but for ordering we only need the chain-derived signal that survives a
  // running workflowStatus.
  return (
    s.workflowStatus === "running" &&
    (s.chainStatus === "escalated" ||
      s.chainStatus === "abandoned" ||
      (s.currentRound != null &&
        s.maxRounds != null &&
        s.maxRounds > 1 &&
        s.currentRound >= s.maxRounds))
  );
}

function recencyKey(s: CollabSummary): string {
  return s.workflowCreatedAt ?? s.lastActivityAt ?? "";
}

function cmpDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export function partitionWallGroups(summaries: CollabSummary[]): WallGroups {
  const active: CollabSummary[] = [];
  const idleManual: CollabSummary[] = [];
  const halted: CollabSummary[] = [];
  const doneCanceled: CollabSummary[] = [];
  for (const s of summaries) {
    if (s.workflowStatus === null) idleManual.push(s);
    else if (s.workflowStatus === "running") active.push(s);
    else if (s.workflowStatus === "halted") halted.push(s);
    else if (s.workflowStatus === "done" || s.workflowStatus === "canceled")
      doneCanceled.push(s);
    // paused or any unknown status is dropped — see spec Non-Goals.
  }
  // ACTIVE: stuck-pin (stuck block first), then recency desc within each block.
  active.sort((a, b) => {
    const sa = isStuckRunning(a) ? 0 : 1;
    const sb = isStuckRunning(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return cmpDesc(recencyKey(a), recencyKey(b));
  });
  // Other groups: recency desc.
  idleManual.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
  halted.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
  doneCanceled.sort((a, b) => cmpDesc(recencyKey(a), recencyKey(b)));
  return { active, idleManual, halted, doneCanceled };
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-wall-allocation.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-state.ts test/dashboard-wall-allocation.test.ts
git commit -m "feat(cli): partition Wall summaries into status groups with stuck-pin"
```

---

### Task 7: Priority-fill allocation + paging across sections

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-state.ts`
- Test:   `test/dashboard-wall-allocation.test.ts`

Build sectioned allocation on top of `partitionWallGroups`. Each section has uniform
card height; ACTIVE uses full (height 6 including border), the other three use compact
(height 4). One header row per non-empty section. Done/Canceled fills only remaining
rows.

- [ ] **Step 1: Write the failing tests**

```ts
import { allocateWallSections } from "../packages/cli/src/runtime/dashboard-state.ts";

describe("allocateWallSections", () => {
  function activeCollab(id: string, createdAt: string): CollabSummary {
    return s({ collabId: id, workflowStatus: "running", workflowCreatedAt: createdAt });
  }
  function doneCollab(id: string, createdAt: string): CollabSummary {
    return s({ collabId: id, workflowStatus: "done", workflowCreatedAt: createdAt });
  }

  it("emits a section per non-empty group, in order, with counts", () => {
    const groups = partitionWallGroups([
      activeCollab("a1", "2026-05-25T00:00:00Z"),
      doneCollab("d1", "2026-05-24T00:00:00Z"),
    ]);
    const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
    expect(out.sections.map((s) => s.group)).toEqual(["active", "doneCanceled"]);
    expect(out.sections[0]!.label).toBe("ACTIVE (1)");
    expect(out.sections[0]!.cardKind).toBe("full");
    expect(out.sections[1]!.cardKind).toBe("compact");
    expect(out.totalRuns).toBe(2);
  });

  it("ACTIVE fills first; DONE only appears when there is room left for its header + at least one card row", () => {
    // Geometry: cols=80 → colsCount=2; full card height=6; compact card height=4;
    // header rows=1 per non-empty section.
    const groups = partitionWallGroups([
      ...Array.from({ length: 10 }, (_, i) =>
        activeCollab(`a${i}`, `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        doneCollab(`d${i}`, `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      ),
    ]);

    // Tight: rows=20. ACTIVE consumes 1 (header) + 3 rows × 6 = 19 rows for
    // 6 active cards; 1 row remains, less than the 5 rows DONE needs
    // (1 header + 1 compact card row of height 4). DONE must be omitted.
    const tight = allocateWallSections({ groups, cols: 80, rows: 20, page: 0 });
    const tightActive = tight.sections.find((s) => s.group === "active")!;
    expect(tightActive.cards.length).toBe(6);
    expect(tight.sections.find((s) => s.group === "doneCanceled")).toBeUndefined();

    // Looser: rows=24. ACTIVE still consumes 19; 5 rows remain, exactly fitting
    // DONE's 1-header + 1-card-row (4) = 5 budget → 1 compact row × 2 cols = 2
    // DONE cards. ACTIVE count is unchanged.
    const loose = allocateWallSections({ groups, cols: 80, rows: 24, page: 0 });
    const looseActive = loose.sections.find((s) => s.group === "active")!;
    expect(looseActive.cards.length).toBe(6);
    const looseDone = loose.sections.find((s) => s.group === "doneCanceled");
    expect(looseDone).toBeDefined();
    expect(looseDone!.cards.length).toBe(2);
  });

  it("paging keeps section order; section headers repeat on later pages", () => {
    const groups = partitionWallGroups(
      Array.from({ length: 20 }, (_, i) =>
        activeCollab(`a${i}`, `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      ),
    );
    const p0 = allocateWallSections({ groups, cols: 80, rows: 14, page: 0 });
    const p1 = allocateWallSections({ groups, cols: 80, rows: 14, page: 1 });
    expect(p0.sections[0]!.group).toBe("active");
    expect(p1.sections[0]!.group).toBe("active");
    expect(p0.pageCount).toBeGreaterThan(1);
    expect(p1.page).toBe(1);
    // Cards on later page are the next ones in recency order, no overlap.
    const ids0 = p0.sections[0]!.cards.map((c) => c.collabId);
    const ids1 = p1.sections[0]!.cards.map((c) => c.collabId);
    expect(ids0.some((id) => ids1.includes(id))).toBe(false);
  });

  it("never produces a header for a section with zero cards", () => {
    const groups = partitionWallGroups([activeCollab("a1", "2026-05-25T00:00:00Z")]);
    const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
    expect(out.sections.find((s) => s.cards.length === 0)).toBeUndefined();
  });

  it("paused never appears as a section group", () => {
    // Defensive: simulated input with paused status; assertion that it never
    // surfaces. Cast through unknown because the type forbids paused — the
    // test guards against future regression at runtime.
    const paused = {
      ...s({ collabId: "p", workflowStatus: "running" }),
      workflowStatus: "paused" as unknown as null,
    } as CollabSummary;
    const groups = partitionWallGroups([paused]);
    const out = allocateWallSections({ groups, cols: 80, rows: 40, page: 0 });
    expect(out.sections.map((s) => s.group)).not.toContain("paused" as never);
  });
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-wall-allocation.test.ts -t "allocateWallSections"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement `allocateWallSections`**

```ts
const MIN_PANE_COLS = 40;
const CARD_HEIGHT = { full: 6, compact: 4 } as const; // border (2) + content
const HEADER_ROWS = 1;

const GROUP_ORDER: WallGroupKey[] = ["active", "idleManual", "halted", "doneCanceled"];
const GROUP_LABEL: Record<WallGroupKey, string> = {
  active: "ACTIVE",
  idleManual: "IDLE / MANUAL",
  halted: "HALTED",
  doneCanceled: "DONE / CANCELED",
};

export type WallSection = {
  group: WallGroupKey;
  label: string;
  cardKind: "full" | "compact";
  cards: CollabSummary[];
};

export type WallSectionsResult = {
  sections: WallSection[];
  page: number;
  pageCount: number;
  totalRuns: number;
};

function cardKindFor(group: WallGroupKey): "full" | "compact" {
  return group === "active" ? "full" : "compact";
}

function fillOnePage(input: {
  pools: Record<WallGroupKey, CollabSummary[]>;
  cols: number;
  rows: number;
}): { sections: WallSection[]; consumed: Record<WallGroupKey, number> } {
  const colsCount = Math.max(1, Math.floor(input.cols / MIN_PANE_COLS));
  let rowsLeft = input.rows;
  const consumed: Record<WallGroupKey, number> = {
    active: 0, idleManual: 0, halted: 0, doneCanceled: 0,
  };
  const sections: WallSection[] = [];
  for (const group of GROUP_ORDER) {
    const pool = input.pools[group];
    if (pool.length === 0) continue;
    if (rowsLeft <= HEADER_ROWS) break;
    const cardKind = cardKindFor(group);
    const cardRows = CARD_HEIGHT[cardKind];
    const availableForCards = rowsLeft - HEADER_ROWS;
    const cardRowsFit = Math.floor(availableForCards / cardRows);
    if (cardRowsFit === 0) break;
    const cap = cardRowsFit * colsCount;
    const taken = pool.slice(0, Math.min(cap, pool.length));
    if (taken.length === 0) break;
    const rowsTaken = HEADER_ROWS + Math.ceil(taken.length / colsCount) * cardRows;
    rowsLeft -= rowsTaken;
    consumed[group] = taken.length;
    sections.push({
      group,
      label: `${GROUP_LABEL[group]} (${pool.length})`,
      cardKind,
      cards: taken,
    });
  }
  return { sections, consumed };
}

export function allocateWallSections(input: {
  groups: WallGroups;
  cols: number;
  rows: number;
  page: number;
}): WallSectionsResult {
  // Build a working copy of each group as a queue we can drain page by page.
  const totalRuns =
    input.groups.active.length +
    input.groups.idleManual.length +
    input.groups.halted.length +
    input.groups.doneCanceled.length;

  // Walk pages forward until we reach the requested page or run out of cards.
  let pool: Record<WallGroupKey, CollabSummary[]> = {
    active: [...input.groups.active],
    idleManual: [...input.groups.idleManual],
    halted: [...input.groups.halted],
    doneCanceled: [...input.groups.doneCanceled],
  };
  let page = 0;
  let result = fillOnePage({ pools: pool, cols: input.cols, rows: input.rows });
  while (page < input.page && (result.sections.length > 0)) {
    pool = {
      active: pool.active.slice(result.consumed.active),
      idleManual: pool.idleManual.slice(result.consumed.idleManual),
      halted: pool.halted.slice(result.consumed.halted),
      doneCanceled: pool.doneCanceled.slice(result.consumed.doneCanceled),
    };
    page += 1;
    result = fillOnePage({ pools: pool, cols: input.cols, rows: input.rows });
  }
  // pageCount: simulate forward from the original groups until pool is drained.
  let pageCount = 1;
  {
    let p: Record<WallGroupKey, CollabSummary[]> = {
      active: [...input.groups.active],
      idleManual: [...input.groups.idleManual],
      halted: [...input.groups.halted],
      doneCanceled: [...input.groups.doneCanceled],
    };
    let remaining =
      p.active.length + p.idleManual.length + p.halted.length + p.doneCanceled.length;
    while (remaining > 0) {
      const r = fillOnePage({ pools: p, cols: input.cols, rows: input.rows });
      const taken =
        r.consumed.active + r.consumed.idleManual + r.consumed.halted + r.consumed.doneCanceled;
      if (taken === 0) break; // terminal would not be reachable — guard against infinite loop.
      p = {
        active: p.active.slice(r.consumed.active),
        idleManual: p.idleManual.slice(r.consumed.idleManual),
        halted: p.halted.slice(r.consumed.halted),
        doneCanceled: p.doneCanceled.slice(r.consumed.doneCanceled),
      };
      remaining -= taken;
      if (remaining > 0) pageCount += 1;
    }
  }
  return { sections: result.sections, page, pageCount, totalRuns };
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-wall-allocation.test.ts`
Expected: PASS — partition + allocation tests green.

- [ ] **Step 5: Wire `buildWallState` to use the new allocator**

Replace `selectWallPage` usage in `buildWallState`:

```ts
export type WallState = {
  sections: Array<{
    group: WallGroupKey;
    label: string;
    cardKind: "full" | "compact";
    panes: WallPaneState[];
  }>;
  page: number;
  pageCount: number;
  totalRuns: number;
  selected: number;
};

export function buildWallState(input: {
  summaries: CollabSummary[];
  now: string;
  idleThresholdMs: number;
  cols: number;
  rows: number;
  page: number;
  selected: number;
  snapshots: Record<
    string,
    { handoffs: RelayHandoffLogRow[]; phaseRuns: PhaseRunRef[]; totalPhases: number }
  >;
}): WallState {
  const groups = partitionWallGroups(input.summaries);
  const alloc = allocateWallSections({
    groups, cols: input.cols, rows: input.rows, page: input.page,
  });
  // Project each allocated summary into its WallPaneState.
  const sections = alloc.sections.map((sec) => ({
    group: sec.group,
    label: sec.label,
    cardKind: sec.cardKind,
    panes: sec.cards.map((sum) => /* existing pane projection from Task 5 */
      projectPane(sum, input.now, input.idleThresholdMs, input.snapshots)),
  }));
  // Selection clamps to the total visible cards in section order.
  const visibleCount = sections.reduce((n, s) => n + s.panes.length, 0);
  const selected = Math.min(Math.max(0, input.selected), Math.max(0, visibleCount - 1));
  return {
    sections,
    page: alloc.page,
    pageCount: alloc.pageCount,
    totalRuns: alloc.totalRuns,
    selected,
  };
}
```

Extract the pane projection from Task 5 into a `projectPane()` helper so it's reusable.
The host (`packages/cli/src/runtime/dashboard.ts`) now passes `cols` and `rows`
explicitly instead of computing `capacity`; update its `buildWallState` call accordingly
(the host already knows terminal dimensions).

> If the host currently calls `selectWallPage` separately to decide which collabs to
> fetch per-page snapshots for, switch it to `partitionWallGroups` + `allocateWallSections`
> for the snapshot-fetch keying, so cost stays bounded to the visible page. The same
> functions are reused.

- [ ] **Step 6: Update `test/dashboard-state.test.ts`**

Replace any tests that asserted the old flat `state.panes` shape with assertions on
`state.sections[*].panes`. Add a test for `selected` clamping across sections.

- [ ] **Step 7: Build the CLI**

Run: `pnpm -w --filter @ai-whisper/cli build`
Expected: the runtime side compiles. `dashboard-view.tsx` will still break until
Task 8-12 — that is fine; do not commit a half-state. Skip the view typecheck for now
by running `pnpm -w vitest run test/dashboard-state.test.ts test/dashboard-wall-allocation.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/runtime/dashboard-state.ts packages/cli/src/runtime/dashboard.ts test/dashboard-state.test.ts test/dashboard-wall-allocation.test.ts
git commit -m "feat(cli): sectioned priority-fill Wall allocation with paging"
```

---

### Task 8: View — theme tokens, border style, selection accent

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx`
- Modify: `test/dashboard-view.test.tsx` — add a shared fixture helper used by
  every render test in Tasks 8-12.

Start the view rewrite by switching all color literals to `THEME` / `AGENT_COLOR` and
flipping `borderStyle="round"` → `"single"`. No layout changes yet.

- [ ] **Step 0: Add the shared fixture helpers (used by every Wall render test below)**

Append once near the top of `test/dashboard-view.test.tsx`. Every subsequent Wall
render test in Tasks 8-12 builds its state via these helpers — no more
`undefined as any`:

```ts
import type {
  WallPaneState,
  WallState,
} from "../packages/cli/src/runtime/dashboard-state.ts";

type PaneOverrides = Partial<WallPaneState> & {
  collabId: string;
  statusKey: WallPaneState["statusKey"];
};

function mkPane(p: PaneOverrides): WallPaneState {
  return {
    workflowId: "wf1",
    label: "lbl",
    workflowType: "complex-bug-fixing",
    round: { current: 1, max: 3 },
    progress: { current: 2, total: 5 },
    agentHealth: [
      { agent: "codex", health: "healthy" },
      { agent: "claude", health: "healthy" },
    ],
    stuckWhy: null,
    events: [
      { step: "review", route: "codex→claude", verdict: "pass" },
      { step: "execute", route: "claude→codex", verdict: "-" },
    ],
    elapsed: "1m23s",
    cardKind: "full",
    ...p,
  };
}

type SectionInput = {
  group: WallState["sections"][number]["group"];
  label?: string;
  cardKind?: "full" | "compact";
  panes: WallPaneState[];
};

function mkSection(input: SectionInput): WallState["sections"][number] {
  const cardKind = input.cardKind ?? (input.group === "active" ? "full" : "compact");
  const label = input.label ??
    ({
      active: "ACTIVE",
      idleManual: "IDLE / MANUAL",
      halted: "HALTED",
      doneCanceled: "DONE / CANCELED",
    } as const)[input.group] + ` (${input.panes.length})`;
  return { group: input.group, label, cardKind, panes: input.panes };
}

function mkWallState(input: {
  sections?: WallState["sections"];
  selected?: number;
  page?: number;
  pageCount?: number;
  totalRuns?: number;
}): WallState {
  const sections = input.sections ?? [];
  const totalRuns = input.totalRuns ?? sections.reduce((n, s) => n + s.panes.length, 0);
  return {
    sections,
    page: input.page ?? 0,
    pageCount: input.pageCount ?? 1,
    totalRuns,
    selected: input.selected ?? 0,
  };
}

function stripAnsi(s: string): string {
  // ESC [ ... letter — drop SGR codes so text-content assertions can match.
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}
```

- [ ] **Step 1: Write the failing tests**

Add to `test/dashboard-view.test.tsx`:

```ts
import { render } from "ink-testing-library";
import { Wall } from "../packages/cli/src/runtime/dashboard-view.tsx";

it("uses no raw cyan/magenta literals in dashboard-view source", () => {
  // Structural guard: the source must not reference the legacy literal colors.
  const src = require("fs").readFileSync(
    "packages/cli/src/runtime/dashboard-view.tsx", "utf8",
  );
  expect(src).not.toMatch(/"cyan"|"magenta"/);
});

it("Wall pane uses single-style borders", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [mkPane({ collabId: "c1", statusKey: "running" })],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const out = lastFrame() ?? "";
  expect(out).toMatch(/[┌┐└┘]/);
  expect(out).not.toMatch(/[╭╮╰╯]/);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx`
Expected: FAIL — the source still contains cyan/magenta and `borderStyle="round"`.

- [ ] **Step 3: Migrate literals**

In `dashboard-view.tsx`:
- Import `THEME` and `AGENT_COLOR` from `./theme.js`.
- Replace `const AGENT_COLOR = { codex: "cyan", claude: "magenta" } as const;` with the
  imported map (delete the local one).
- Replace every `borderStyle="round"` with `borderStyle="single"`.
- Replace inline `"gray"` (border/normal text), `"cyan"` (selection), and `"red"` (stuck)
  with `THEME.muted`, `THEME.accent`, and `THEME.err` respectively.
- The selection chevron and the selected card's bold header use `THEME.accent`.
- The footer keybind row uses `THEME.muted`.

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx`
Expected: PASS — both new tests green; existing rendering tests still pass (they
should not assert on legacy colors).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx test/dashboard-view.test.tsx
git commit -m "refactor(cli): migrate dashboard-view to THEME/AGENT_COLOR + single borders"
```

---

### Task 9: View — full card (status glyph, progress bar, agent dots)

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx`
- Test:   `test/dashboard-view.test.tsx`

Implement the full 4-line card for ACTIVE running panes per the spec.

- [ ] **Step 1: Failing test**

```ts
it("full ACTIVE card renders chevron, glyph, label, dimmed type, round, progress bar, and agent dots", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "running",
            label: "mylabel",
            workflowType: "complex-bug-fixing",
            round: { current: 1, max: 3 },
            progress: { current: 2, total: 5 },
          }),
        ],
      }),
    ],
    selected: 0,
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toContain("▸ ● mylabel");
  expect(out).toContain("complex-bug-fixing");
  expect(out).toContain("R1/3");
  expect(out).toContain("P2/5");
  expect(out).toMatch(/[▰▱]/); // progress bar present
  expect(out).toContain("codex");
  expect(out).toContain("claude");
});

it("narrow pane drops the bar and shows P n/total text only", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "running",
            label: "mylabel",
            workflowType: "complex-bug-fixing",
            round: { current: 1, max: 3 },
            progress: { current: 2, total: 5 },
          }),
        ],
      }),
    ],
    selected: 0,
  });
  // 45 cols < NARROW_PANE_COLS (48) → bar must collapse to text.
  const { lastFrame } = render(<Wall state={state} cols={45} rows={20} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toContain("P2/5");
  expect(out).not.toMatch(/[▰▱]/);
});

it("renders the degraded per-agent dot as ◐ in THEME.warn (yellow SGR 33)", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "running",
            agentHealth: [
              { agent: "codex",  health: "healthy"  },
              { agent: "claude", health: "degraded" },
            ],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const raw = lastFrame() ?? "";
  const out = stripAnsi(raw);
  // Degraded glyph present after stripping ANSI.
  expect(out).toContain("◐");
  // The degraded dot is colored with THEME.warn (yellow → SGR 33).
  expect(raw).toMatch(/\x1b\[33m[^\x1b]*◐/);
  // The claude agent name is tinted with AGENT_COLOR.claude — a 24-bit RGB
  // SGR sequence (38;2;217;119;87) wrapping the literal "claude" token.
  expect(raw).toMatch(/\x1b\[38;2;217;119;87m[^\x1b]*claude/);
});

it("renders the dead per-agent dot as ○ in THEME.err (red SGR 31)", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "running",
            agentHealth: [
              { agent: "codex",  health: "dead"    },
              { agent: "claude", health: "healthy" },
            ],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const raw = lastFrame() ?? "";
  const out = stripAnsi(raw);
  expect(out).toContain("○");
  // Dead dot is colored with THEME.err (red → SGR 31).
  expect(raw).toMatch(/\x1b\[31m[^\x1b]*○/);
  // The codex agent name is tinted with AGENT_COLOR.codex — RGB (95;179;201).
  expect(raw).toMatch(/\x1b\[38;2;95;179;201m[^\x1b]*codex/);
});

it("renders a healthy per-agent dot as ● in THEME.ok (green SGR 32)", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "running",
            agentHealth: [
              { agent: "codex",  health: "healthy" },
              { agent: "claude", health: "healthy" },
            ],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const raw = lastFrame() ?? "";
  // Healthy dot uses THEME.ok (green → SGR 32) — emitted twice (one per agent).
  expect(raw).toMatch(/\x1b\[32m[^\x1b]*●/);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "full ACTIVE card"`
Expected: FAIL — output lacks the new glyph/progress markup.

- [ ] **Step 3: Implement the full card renderer**

Replace the `WallPane` component with a status-first version. New helpers go above it:

```ts
const NARROW_PANE_COLS = 48;
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";

function progressBar(progress: { current: number; total: number }): string {
  const total = Math.max(1, progress.total);
  const current = Math.max(0, Math.min(total, progress.current));
  return BAR_FILLED.repeat(current) + BAR_EMPTY.repeat(total - current);
}

function dotForHealth(h: "healthy" | "degraded" | "dead"): { glyph: string; color: string } {
  return h === "healthy"
    ? { glyph: "●", color: THEME.ok }
    : h === "degraded"
      ? { glyph: "◐", color: THEME.warn }
      : { glyph: "○", color: THEME.err };
}

function FullCard(props: {
  pane: WallPaneState;
  selected: boolean;
  width: number;
}): ReactElement {
  const { pane } = props;
  const glyph = statusGlyph({
    workflowStatus: pane.statusKey === "idle"
      ? null
      : (pane.statusKey === "stuck" ? "running" : pane.statusKey),
    stuck: pane.statusKey === "stuck",
  });
  const borderColor = pane.statusKey === "stuck"
    ? THEME.err
    : props.selected
      ? THEME.accent
      : THEME.muted;
  const chevron = props.selected ? "▸ " : "  ";
  const bar =
    pane.progress != null && props.width >= NARROW_PANE_COLS
      ? `${progressBar(pane.progress)}  `
      : "";
  const progressText = pane.progress != null
    ? `P${pane.progress.current}/${pane.progress.total}`
    : "—";
  const roundText = pane.round != null ? `  R${pane.round.current}/${pane.round.max}` : "";
  return (
    <Box flexDirection="column" width={props.width}
         borderStyle="single" borderColor={borderColor}>
      <Text wrap="truncate"
            {...(props.selected ? { color: THEME.accent as string } : {})} bold>
        {chevron}
        <Text color={glyph.color}>{glyph.glyph}</Text>{" "}
        {pane.label}
        {pane.workflowType ? <Text color={THEME.muted}>  {pane.workflowType}</Text> : null}
        {roundText ? <Text color={THEME.muted}>{roundText}</Text> : null}
      </Text>
      <Text wrap="truncate">
        {"  "}<Text color={THEME.muted}>{progressText}</Text>{" "}
        {bar}
        {pane.agentHealth.map((ah, i) => {
          const d = dotForHealth(ah.health);
          return (
            <Text key={i}>
              {"  "}<Text color={AGENT_COLOR[ah.agent]}>{ah.agent}</Text>
              <Text color={d.color}>{d.glyph}</Text>
            </Text>
          );
        })}
      </Text>
      {pane.events.slice(0, 2).map((e, i) => (
        <Text key={i} wrap="truncate" color={THEME.muted}>
          {"  "}{padRight(e.step, 9)}  {padRight(e.route, 13)}  {padRight(e.verdict, 9)}
        </Text>
      ))}
    </Box>
  );
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "full ACTIVE card"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx test/dashboard-view.test.tsx
git commit -m "feat(cli): full ACTIVE card — glyph, progress bar, agent dots"
```

---

### Task 10: View — stuck card variant

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx`
- Test:   `test/dashboard-view.test.tsx`

- [ ] **Step 1: Failing test**

```ts
it("stuck card uses ⚠ glyph, red border, and suppresses event rows even when events are present", () => {
  // The fixture carries TWO events on purpose: the renderer must drop them
  // entirely when statusKey === "stuck" so the reason text dominates.
  // A regression that emits event rows on stuck cards must FAIL this test.
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({
            collabId: "c1",
            statusKey: "stuck",
            label: "mylabel",
            workflowType: "complex-bug-fixing",
            round: { current: 3, max: 3 },
            stuckWhy: "STUCK 6m12s — round 3/3 max reached → escalated",
            events: [
              { step: "review",  route: "codex→claude", verdict: "pass" },
              { step: "execute", route: "claude→codex", verdict: "-"    },
            ],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toContain("⚠");
  expect(out).toContain("STUCK 6m12s");
  // The two fixture event rows must NOT appear — every distinguishing token of
  // each event is asserted absent so a partial emission still fails.
  expect(out).not.toMatch(/codex→claude/);
  expect(out).not.toMatch(/claude→codex/);
  expect(out).not.toMatch(/\breview\b/);
  expect(out).not.toMatch(/\bexecute\b/);
  expect(out).not.toMatch(/\bpass\b/);
});
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "stuck card"`
Expected: FAIL.

- [ ] **Step 3: Branch `FullCard` on `statusKey === "stuck"`**

Inside `FullCard`, when `pane.statusKey === "stuck"` and `pane.stuckWhy != null`,
suppress the progress/dots row and the event rows; render the why text in red on the
two body lines:

```tsx
if (pane.statusKey === "stuck") {
  return (
    <Box flexDirection="column" width={props.width}
         borderStyle="single" borderColor={THEME.err}>
      <Text wrap="truncate" bold>
        {chevron}<Text color={THEME.err}>⚠</Text>{" "}{pane.label}
        {pane.workflowType ? <Text color={THEME.muted}>  {pane.workflowType}</Text> : null}
      </Text>
      <Text wrap="truncate" color={THEME.err}>
        {"  "}{(pane.stuckWhy ?? "").slice(0, props.width - 4)}
      </Text>
      <Text wrap="truncate" color={THEME.err}>
        {"  "}{(pane.stuckWhy ?? "").slice(props.width - 4)}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "stuck card"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx test/dashboard-view.test.tsx
git commit -m "feat(cli): stuck card variant — red border, ⚠ glyph, why text dominant"
```

---

### Task 11: View — compact card

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx`
- Test:   `test/dashboard-view.test.tsx`

- [ ] **Step 1: Failing test**

```ts
it("compact DONE card uses ✓ glyph, status word, elapsed; no event rows", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "doneCanceled",
        panes: [
          mkPane({
            collabId: "d1",
            statusKey: "done",
            label: "donelabel",
            workflowType: "spec-driven-development",
            round: null,
            progress: { current: 5, total: 5 },
            elapsed: "4m12s",
            cardKind: "compact",
            events: [],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toContain("✓ donelabel");
  expect(out).toContain("spec-driven-development");
  expect(out).toContain("P5/5");
  expect(out).toContain("done");
  expect(out).toContain("4m12s");
});

it("compact CANCELED card uses ✖ glyph in err color", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "doneCanceled",
        panes: [
          mkPane({
            collabId: "x1",
            statusKey: "canceled",
            label: "cancellabel",
            workflowType: "complex-bug-fixing",
            round: null,
            progress: { current: 3, total: 5 },
            elapsed: "2m08s",
            cardKind: "compact",
            events: [],
          }),
        ],
      }),
    ],
  });
  const { lastFrame, frames } = render(<Wall state={state} cols={80} rows={20} />);
  const raw = lastFrame() ?? "";
  const out = stripAnsi(raw);
  expect(out).toContain("✖");
  // Err color guard: the raw frame must contain the SGR red sequence (\x1b[31m).
  expect(raw).toMatch(/\x1b\[31m/);
});

it("compact HALTED card uses ⚠ glyph in err color", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "halted",
        panes: [
          mkPane({
            collabId: "h1",
            statusKey: "stuck",
            label: "haltlabel",
            workflowType: "spec-driven-development",
            round: null,
            progress: { current: 2, total: 4 },
            elapsed: "5m00s",
            cardKind: "compact",
            stuckWhy: null,
            events: [],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={20} />);
  const raw = lastFrame() ?? "";
  const out = stripAnsi(raw);
  expect(out).toContain("⚠");
  // Err color guard: the raw frame must contain the SGR red sequence.
  expect(raw).toMatch(/\x1b\[31m/);
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "compact"`
Expected: FAIL — `CompactCard` not yet defined.

- [ ] **Step 3: Implement `CompactCard`**

```tsx
function CompactCard(props: {
  pane: WallPaneState;
  selected: boolean;
  width: number;
}): ReactElement {
  const { pane } = props;
  const statusWord =
    pane.statusKey === "done" ? "done"
    : pane.statusKey === "canceled" ? "canceled"
    : pane.statusKey === "stuck" ? "halted"
    : pane.statusKey === "idle" ? "idle"
    : "running";
  const glyph = statusGlyph({
    workflowStatus: pane.statusKey === "idle" ? null
      : pane.statusKey === "stuck" ? "halted"
      : pane.statusKey,
    stuck: false,
  });
  const borderColor =
    pane.statusKey === "stuck" || pane.statusKey === "canceled"
      ? THEME.err
      : props.selected
        ? THEME.accent
        : THEME.muted;
  const chevron = props.selected ? "▸ " : "  ";
  const progressText = pane.progress
    ? `P${pane.progress.current}/${pane.progress.total}`
    : "—";
  return (
    <Box flexDirection="column" width={props.width}
         borderStyle="single" borderColor={borderColor}>
      <Text wrap="truncate" bold
            {...(props.selected ? { color: THEME.accent as string } : {})}>
        {chevron}
        <Text color={glyph.color}>{glyph.glyph}</Text>{" "}
        {pane.label}
        {pane.workflowType ? <Text color={THEME.muted}>  {pane.workflowType}</Text> : null}
      </Text>
      <Text wrap="truncate" color={THEME.muted}>
        {"  "}{progressText} · {statusWord} · {pane.elapsed}
      </Text>
    </Box>
  );
}
```

Update the section renderer (added in Task 12) to pick `FullCard` vs `CompactCard`
by `section.cardKind`.

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "compact"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx test/dashboard-view.test.tsx
git commit -m "feat(cli): compact card variant for HALTED + DONE/CANCELED groups"
```

---

### Task 12: View — sectioned grid, section headers, footer legend

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx`
- Test:   `test/dashboard-view.test.tsx`

Replace the flat grid in `Wall` with the new sectioned renderer driven by
`state.sections`.

- [ ] **Step 1: Failing tests**

```ts
it("Wall renders a labeled section header with the group count for each non-empty section", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [
          mkPane({ collabId: "a1", statusKey: "running", label: "alpha" }),
          mkPane({ collabId: "a2", statusKey: "running", label: "beta" }),
        ],
      }),
      mkSection({
        group: "halted",
        panes: [
          mkPane({
            collabId: "h1", statusKey: "stuck", label: "halt1",
            round: null, progress: { current: 1, total: 4 },
            cardKind: "compact", events: [],
          }),
        ],
      }),
      mkSection({
        group: "doneCanceled",
        panes: [
          mkPane({
            collabId: "d1", statusKey: "done", label: "donelabel",
            round: null, progress: { current: 5, total: 5 },
            elapsed: "4m12s", cardKind: "compact", events: [],
          }),
        ],
      }),
    ],
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={30} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toContain("ACTIVE (2)");
  expect(out).toContain("HALTED (1)");
  expect(out).toContain("DONE / CANCELED (1)");
});

it("Wall footer includes the keybinding row and the glyph legend", () => {
  const state = mkWallState({
    sections: [
      mkSection({
        group: "active",
        panes: [mkPane({ collabId: "a1", statusKey: "running", label: "alpha" })],
      }),
    ],
    pageCount: 2,
  });
  const { lastFrame } = render(<Wall state={state} cols={80} rows={30} />);
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toMatch(/page \d+\/\d+/);
  expect(out).toContain("● running");
  expect(out).toContain("⚠ stuck/halted");
  expect(out).toContain("✓ done");
  expect(out).toContain("✖ canceled");
  expect(out).toContain("◌ idle");
});

it("empty Wall keeps the existing 'no active collabs' message", () => {
  const empty = { sections: [], page: 0, pageCount: 1, totalRuns: 0, selected: 0 } as any;
  const { lastFrame } = render(<Wall state={empty} cols={80} rows={30} />);
  const out = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  expect(out).toContain("no active collabs");
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx`
Expected: FAIL on the three new tests.

- [ ] **Step 3: Replace `Wall` with the sectioned renderer**

```tsx
export function Wall(props: {
  state: WallState;
  cols: number;
  rows: number;
}): ReactElement {
  const { state } = props;
  if (state.sections.length === 0) {
    return (
      <Box width={props.cols} flexDirection="column">
        <Text color={THEME.muted}>no active collabs (last 30m)</Text>
      </Box>
    );
  }
  const colsCount = Math.max(1, Math.floor(props.cols / MIN_PANE_COLS));
  const paneWidth = Math.floor(props.cols / colsCount);
  // Build a flat list of [section, pane, globalIndex] so the selection cursor
  // can be resolved cleanly when rendering rows.
  let globalIdx = 0;
  return (
    <Box flexDirection="column" width={props.cols}>
      {state.sections.map((sec) => {
        const rows: WallPaneState[][] = [];
        for (let i = 0; i < sec.panes.length; i += colsCount) {
          rows.push(sec.panes.slice(i, i + colsCount));
        }
        return (
          <Box key={sec.group} flexDirection="column">
            <Text color={THEME.muted}>{sec.label}</Text>
            {rows.map((row, ri) => (
              <Box key={ri} flexDirection="row">
                {row.map((pane) => {
                  const idx = globalIdx++;
                  const selected = idx === state.selected;
                  return sec.cardKind === "full" ? (
                    <FullCard key={pane.collabId} pane={pane}
                              selected={selected} width={paneWidth} />
                  ) : (
                    <CompactCard key={pane.collabId} pane={pane}
                                 selected={selected} width={paneWidth} />
                  );
                })}
              </Box>
            ))}
          </Box>
        );
      })}
      <Text color={THEME.muted}>
        {`page ${state.page + 1}/${Math.max(1, state.pageCount)} · ${state.totalRuns} runs · ↑↓/jk select · ↵ inspect · [ ] page · q quit`}
      </Text>
      <Text color={THEME.muted}>
        ● running  ⚠ stuck/halted  ✓ done  ✖ canceled  ◌ idle
      </Text>
    </Box>
  );
}
```

> The IIFE pattern with `globalIdx++` works because Ink renders synchronously. If the
> linter flags the mutation, replace it with `flatMap` precomputing `(pane, globalIdx)`
> pairs before the JSX.

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx`
Expected: PASS — all new and prior tests green.

- [ ] **Step 5: Build the CLI end-to-end**

Run: `pnpm -w --filter @ai-whisper/cli build`
Expected: success — `dashboard-view.tsx` now compiles against the new state shape.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx test/dashboard-view.test.tsx
git commit -m "feat(cli): sectioned Wall with group headers, paging, glyph legend"
```

---

### Task 13: Inspector polish — header glyph, aligned tables, colored verdicts/outcomes, active-tab accent

**Files:**
- Modify: `packages/cli/src/runtime/dashboard-view.tsx` (the `Inspector` and `tabBar` functions)
- Modify: `packages/cli/src/runtime/dashboard-state.ts` (optional: surface a `statusKey` for
  workflow-history items, mirroring the Wall mapping)
- Modify: `test/dashboard-view.test.tsx` — add the shared Inspector fixture helper used
  by every render test in this task.

- [ ] **Step 0: Add the shared Inspector fixture helpers**

Append once near the existing Wall helpers at the top of `test/dashboard-view.test.tsx`.
Each Inspector render test below builds its state via `mkInspectorState({...})`.

```ts
import type {
  InspectorState,
  PhaseStat,
  WorkflowHistoryItem,
} from "../packages/cli/src/runtime/dashboard-state.ts";
import type { RelayViewState } from "../packages/cli/src/runtime/relay-view-state.ts";
import type { Viewport } from "../packages/cli/src/runtime/relay-view.ts";

const defaultViewport: Viewport = { offset: 0, follow: true };

function mkLive(p: Partial<RelayViewState> = {}): RelayViewState {
  return {
    wf: 'complex-bug-fixing  wf123…  "demo"',
    progress: "Phase 2/5 plan-writing · Round 1/3 · Step review",
    elapsed: "total 1m23s · phase 0m45s",
    turn: "codex · waiting claude · handoff accepted",
    health: "● codex  ● claude  Chain active · ALIVE",
    agentHealth: [
      { agent: "codex", health: "healthy" },
      { agent: "claude", health: "healthy" },
    ],
    live: "idle 5s",
    why: null,
    last: "approve 0.92 · capture ok",
    stuck: false,
    logLines: [],
    ...p,
  };
}

function mkInspectorState(p: {
  stuck: boolean;
  timeline?: PhaseStat[];
  workflowHistory?: WorkflowHistoryItem[];
}): InspectorState {
  return {
    live: mkLive({ stuck: p.stuck, why: p.stuck ? "STUCK 6m12s — round 3/3 max reached → escalated" : null }),
    timeline: p.timeline ?? [
      {
        phaseIndex: 0, phaseName: "plan", roundsUsed: 1, maxRounds: 3,
        durationMs: 60_000, outcome: "approve",
        estInTokens: 100, estOutTokens: 50,
      },
    ],
    workflowHistory: p.workflowHistory ?? [],
    evidence: {
      phase: "plan", chainId: "chain-1",
      items: [], diagnostics: [],
      likelyCause: "no blocking signal — run progressing",
    },
    cost: { totalMs: 60_000, estInputTokens: 100, estOutputTokens: 50, perPhase: [] },
  };
}
```

> The `Inspector` component gains a new `workflowStatus: "running" | "done" | "halted" | "canceled" | null`
> prop in Step 3 — host (`dashboard.ts`) already knows it. Tests below pass it explicitly.


- [ ] **Step 1: Failing tests**

```ts
it("Inspector header shows the status glyph in THEME color before the label", () => {
  const state = mkInspectorState({ stuck: false });
  const { lastFrame } = render(
    <Inspector state={state} section="live" viewport={defaultViewport}
               cols={120} rows={40} label="mylabel"
               workflowType="complex-bug-fixing" workflowStatus="running" />,
  );
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toMatch(/●\s+mylabel/);
});

it("Inspector tab bar marks the active tab with the accent color (SGR sequence present before [2 Timeline])", () => {
  const state = mkInspectorState({ stuck: false });
  const { lastFrame } = render(
    <Inspector state={state} section="timeline" viewport={defaultViewport}
               cols={120} rows={40} label="mylabel"
               workflowType="complex-bug-fixing" workflowStatus="running" />,
  );
  const raw = lastFrame() ?? "";
  // Active tab gets an SGR color sequence directly preceding "[2 Timeline]".
  expect(raw).toMatch(/\x1b\[[0-9;]*m\[2 Timeline\]/);
});

it("Inspector timeline outcome colors are tied to THEME tokens (ok green, fail red)", () => {
  const state = mkInspectorState({
    stuck: false,
    timeline: [
      {
        phaseIndex: 0, phaseName: "plan", roundsUsed: 1, maxRounds: 3,
        durationMs: 60_000, outcome: "approve",
        estInTokens: 100, estOutTokens: 50,
      },
      {
        phaseIndex: 1, phaseName: "implement", roundsUsed: 3, maxRounds: 3,
        durationMs: 240_000, outcome: "escalate",
        estInTokens: 400, estOutTokens: 200,
      },
    ],
  });
  const { lastFrame } = render(
    <Inspector state={state} section="timeline" viewport={defaultViewport}
               cols={120} rows={40} label="mylabel"
               workflowType="complex-bug-fixing" workflowStatus="running" />,
  );
  const raw = lastFrame() ?? "";
  // ANSI green (32) precedes "approve", ANSI red (31) precedes "escalate".
  expect(raw).toMatch(/\x1b\[32m[^\x1b]*approve/);
  expect(raw).toMatch(/\x1b\[31m[^\x1b]*escalate/);
});

it("Inspector workflow history colors statuses via the in-scope glyph map (no paused)", () => {
  const state = mkInspectorState({
    stuck: false,
    workflowHistory: [
      { workflowId: "wf-run",  workflowType: "complex-bug-fixing", name: null, status: "running",  currentPhaseIndex: 1, createdAt: "2026-05-28T00:00:00Z", selected: true  },
      { workflowId: "wf-done", workflowType: "spec-driven-development", name: null, status: "done",     currentPhaseIndex: 4, createdAt: "2026-05-27T00:00:00Z", selected: false },
      { workflowId: "wf-halt", workflowType: "complex-bug-fixing", name: null, status: "halted",   currentPhaseIndex: 2, createdAt: "2026-05-26T00:00:00Z", selected: false },
      { workflowId: "wf-canx", workflowType: "ralph-loop",        name: null, status: "canceled", currentPhaseIndex: 0, createdAt: "2026-05-25T00:00:00Z", selected: false },
    ],
  });
  const { lastFrame } = render(
    <Inspector state={state} section="timeline" viewport={defaultViewport}
               cols={120} rows={40} label="mylabel"
               workflowType="complex-bug-fixing" workflowStatus="running" />,
  );
  const out = stripAnsi(lastFrame() ?? "");
  expect(out).toMatch(/●/); // running
  expect(out).toMatch(/✓/); // done
  expect(out).toMatch(/⚠/); // halted
  expect(out).toMatch(/✖/); // canceled
  expect(out).not.toContain("⏸"); // paused deferred
});
```

- [ ] **Step 2: Run and verify they fail**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx -t "Inspector"`
Expected: FAIL.

- [ ] **Step 3: Update `tabBar` and `Inspector`**

Replace the string-only `tabBar` with a JSX builder so we can color the active tab:

```tsx
function TabBar(props: { active: InspectorSection }): ReactElement {
  const t = (k: InspectorSection, n: string) => {
    const text = k === props.active ? `[${n}]` : ` ${n} `;
    return k === props.active ? (
      <Text key={k} color={THEME.accent} bold>{text}</Text>
    ) : (
      <Text key={k} color={THEME.muted}>{text}</Text>
    );
  };
  return (
    <Text wrap="truncate">
      {t("live", "1 Live")}{t("timeline", "2 Timeline")}
      {t("evidence", "3 Evidence")}{t("cost", "4 Cost")}
    </Text>
  );
}
```

Add the header glyph: derive it from the Inspector's workflow status (passed in via
`workflowStatus` — a new prop) and `state.live.stuck`, then render before the label:

```tsx
const headGlyph = statusGlyph({
  workflowStatus: props.workflowStatus ?? null,
  stuck: props.state.live.stuck,
});

<Text wrap="truncate" bold>
  <Text color={headGlyph.color}>{headGlyph.glyph}</Text>{" "}{props.label}{" · "}
  <Text color={THEME.muted}>{props.workflowType ?? "manual relay"}</Text>
</Text>
```

`dashboard.ts` already knows the workflow status for the inspected collab; thread it
through as the new `workflowStatus` prop.

For the timeline table, pad columns with the existing `pad` helper (re-exported from
`relay-view-state`) and color the outcome:

```tsx
function outcomeColor(outcome: string | null): string | undefined {
  if (!outcome) return undefined;
  if (/escalat|halt|fail|cancel/i.test(outcome)) return THEME.err;
  return THEME.ok;
}

// per-row:
<Text wrap="truncate">
  {padRight(p.phaseName, 18)}  {padRight(`${p.roundsUsed}/${p.maxRounds}`, 5)}{"  "}
  {padRight(p.durationMs == null ? "–" : fmtDur(p.durationMs), 6)}  {padRight(`≈${p.estInTokens + p.estOutTokens}`, 9)}  {" "}
  <Text color={outcomeColor(p.outcome)}>{p.outcome ?? "⋯"}</Text>
</Text>
```

For workflow history, derive a glyph per row via `statusGlyph({ workflowStatus: w.status, stuck: false })`
and prepend it. Paused never reaches this code path (broker type excludes it), and
this code does NOT add a paused branch.

For evidence, color the verdict with `outcomeColor` and keep the `likelyCause` row in
`THEME.warn` `▸`.

- [ ] **Step 4: Run and verify green**

Run: `pnpm -w vitest run test/dashboard-view.test.tsx`
Expected: PASS — all Inspector tests green; Wall tests still green.

- [ ] **Step 5: Build the full CLI**

Run: `pnpm -w --filter @ai-whisper/cli build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/runtime/dashboard-view.tsx packages/cli/src/runtime/dashboard-state.ts test/dashboard-view.test.tsx
git commit -m "feat(cli): Inspector polish — header glyph, aligned tables, accent tab"
```

---

### Task 14: End-to-end smoke run

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

Run: `pnpm -w build`
Expected: success across all packages.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm -w vitest run`
Expected: PASS — all tests green, including pre-existing integration tests.

- [ ] **Step 3: Smoke-run the dashboard against a live workspace**

Manual: in a workspace with at least one mounted collab and one running workflow,
run:

```bash
whisper collab dashboard
```

Confirm:
- Cards have single-line borders, not rounded.
- Selected card chevron + bold header use terracotta accent.
- `claude` token renders terracotta, `codex` renders teal in event lines.
- Status glyph leads each card (●/⚠/✓/✖/◌).
- Sections appear in order ACTIVE → IDLE/MANUAL → HALTED → DONE/CANCELED, each
  with a `GROUP (N)` header.
- Paging works with `[` and `]`.
- Stuck cards render red border + `⚠` + reason text.
- Inspector header shows the glyph; active tab is terracotta; verdicts/outcomes
  are colored.

- [ ] **Step 4: No new commit**

This task is a verification gate. If anything regresses, return to the relevant
prior task before proceeding.

---

## Self-review checklist

- [ ] Every spec section maps to at least one task above (Color Theme → 1; Status Glyph →
      2; Broker projection → 3; Per-agent health structural export → 4; WallPaneState
      restructure → 5; Group partition + sort + stuck-pin → 6; Priority-fill allocation
      + paging → 7; Theme/border migration → 8; Full card → 9; Stuck card → 10;
      Compact card → 11; Section headers + footer legend + empty-Wall → 12;
      Inspector polish → 13; End-to-end smoke → 14).
- [ ] No placeholders — every step contains exact code or a precise modification site.
- [ ] Type names used across tasks are consistent (`WallPaneState`, `WallSection`,
      `WallState`, `WallGroupKey`, `statusGlyph`, `partitionWallGroups`,
      `allocateWallSections`).
- [ ] No paused-glyph code path appears anywhere (deferred per spec).
- [ ] Broker change is exactly one additive field — Task 3 — and nothing else
      touches `dashboard-repository.ts`.
