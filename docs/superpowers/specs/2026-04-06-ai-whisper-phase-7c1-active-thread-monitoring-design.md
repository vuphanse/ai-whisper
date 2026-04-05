# ai-whisper Phase 7C1 Active Thread Monitoring Design

**Date:** 2026-04-06

## Purpose

Phase 7C was originally the operator tooling bucket. That bucket is too large to specify and implement as one phase without becoming vague.

This document defines the first Phase 7C slice only:

- operator visibility for the current collab
- read-only inspection of the active thread
- optional live monitoring in the terminal

It does not attempt to become a full broker console or admin control plane.

## Roadmap Refinement

The roadmap should now be read as:

- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7A: attach and rebind existing sessions
- Phase 7B: broker restart recovery
- Phase 7C1: active-thread monitoring and operator inspection
- Later 7C follow-up: deeper diagnostics, history browsing, artifact inspection, and richer operator tooling

## Phase 7C1 Goal

Phase 7C1 is successful when an operator can:

1. quickly understand current collab health from `whisper collab status`
2. inspect the active thread in a compact read-only view
3. see recent work items, replies, and blocked or failed activity for the active thread
4. watch that active thread and role health update live in the terminal
5. do all of the above without mutating broker state or replaying work

The goal is operational clarity, not control.

## In Scope

Phase 7C1 includes:

- richer `whisper collab status`
- new `whisper collab inspect`
- new `whisper collab inspect --watch`
- compact default output
- truncated content previews by default
- active-thread-only inspection
- per-role binding and health visibility
- recovery-aware operator guidance
- recent work item and reply visibility for the active thread
- visibility into recent failed or `recovery_blocked` work for the active thread

## Out Of Scope

Phase 7C1 does not include:

- editing thread state
- replaying, retrying, or mutating work items
- browsing non-active historical threads
- artifact content inspection
- event-log explorer UX
- provider-native conversation recovery
- interactive TUI dashboards
- long-lived operator daemons beyond `--watch`
- structured JSON output as a first-class surface
- admin actions beyond the already existing `recover` and `reconnect` commands

Those remain later 7C follow-up work if needed.

## Design Overview

Phase 7C1 should introduce a two-layer operator view:

- `whisper collab status` stays the fast health snapshot
- `whisper collab inspect` becomes the deeper read-only operator view for the active thread

The architectural rule is:

- `status` answers "is the collab healthy and what needs attention?"
- `inspect` answers "what is happening in the active thread right now?"

Both commands remain workspace-local and collab-local, consistent with the current one-active-collab-per-workspace model.

## Command Surface

### `whisper collab status`

`status` should remain short and scannable.

It should show:

- collab id
- broker health
- recovery state
- per-role binding state
- per-role runtime health
- active thread id and title when present
- next-step guidance when recovery or reconnect action is needed

It should not dump recent replies or work items. That belongs to `inspect`.

### `whisper collab inspect`

`inspect` is a read-only active-thread operator view.

Default behavior:

- operate on the active thread only
- print a compact snapshot and exit
- use truncated content previews

It should show:

- active thread id, title, and thread state
- current turn index
- recent work items for that thread
- recent replies for that thread
- recent failed or `recovery_blocked` work items for that thread
- current per-role binding and health summary at the top

If there is no active thread, `inspect` should say so clearly and still show current collab and role health context.

### `whisper collab inspect --watch`

`--watch` is the live monitoring mode for the same operator view.

Behavior:

- refresh periodically in the terminal
- redraw the whole compact view each interval
- remain read-only
- exit on Ctrl+C

This is not a full-screen interactive TUI. It is a simple periodic redraw monitor.

## Output Model

### Status Output

Status output should remain intentionally short. A healthy collab should fit in a few lines.

Example shape:

```text
Collab active: collab_...
  Codex: bound (healthy)
  Claude: bound (healthy)
  Broker health: ok
  Active thread: Review plan
```

Recovery or degraded cases should add short action guidance rather than verbose diagnostics.

### Inspect Snapshot Output

Inspect output should be grouped in stable sections:

1. collab and health summary
2. active thread summary
3. recent work items
4. recent replies
5. recent failures or blocked items

The command should favor readability over raw completeness.

Content previews should be truncated by default so the command stays compact. Full unbounded reply bodies are not the default operator experience.

### Inspect Watch Output

Watch mode should reuse the same sections as snapshot mode.

Differences:

- include a clear header that the view is live
- include a last refreshed timestamp
- periodically redraw instead of appending forever

Append-only log output is intentionally not the first design because it makes the view noisier and harder to scan during an ongoing collab.

## Data Selection Rules

Phase 7C1 should stay narrow and deterministic.

Recommended defaults:

- recent work items: last 5
- recent replies: last 5
- failures or blocked work: last 5 relevant items for the active thread

The selection should be reverse chronological for operator readability.

Inspection should use existing broker state rather than inventing new monitoring tables. This phase is about better read surfaces over current state, not a new telemetry subsystem.

## Recovery And Health Semantics

Phase 7C1 must reuse the Phase 7B recovery model rather than inventing a new one.

That means:

- broker loss should still surface as `recovery_required`
- recovered collabs should still surface as `recovered`
- degraded roles should remain visibly degraded until reconnect succeeds
- blocked work after recovery should be visible in `inspect`

`status` is the operator's fast signal that action is needed.
`inspect` is the operator's deeper read surface for understanding why.

## Error Handling

### No Active Collab

- `status` should continue to report no active collab
- `inspect` should fail clearly with a message that there is no active collab

### No Active Thread

`inspect` should not fail hard just because there is no active thread.

It should:

- show the collab and role health summary
- say there is no active thread
- omit the thread-specific item sections or render them as empty

### Broker Unavailable

If broker state requires recovery, both `status` and `inspect` should reflect that clearly.

For `inspect`, recovery-required state should be surfaced before attempting a misleading active-thread readout.

### Watch Mode Interrupt

`inspect --watch` should exit cleanly on Ctrl+C without leaving background processes behind.

## Why This Is A Separate 7C Slice

This slice is intentionally small because broader operator tooling expands quickly.

Once active-thread monitoring exists, later follow-up work can decide whether to add:

- historical thread browsing
- artifact inspection
- event log exploration
- richer failure drill-down
- exportable machine-readable views
- broader operator diagnostics

Those are valid future directions, but they should not blur the first operator-inspection contract.

## Testing Expectations

Phase 7C1 should be verified with:

- unit tests for enriched status output
- unit tests for inspect snapshot selection and truncation behavior
- unit tests for watch-mode refresh and clean exit behavior
- recovery-state tests showing degraded and blocked activity in inspect output
- manual smoke testing in a live collab with active relay traffic

The watch-mode tests should focus on deterministic redraw behavior and operator-readable output, not terminal-perfect UI rendering.

## Success Criteria

Phase 7C1 is complete when:

- operators can tell whether a collab is healthy from `status`
- operators can inspect the active thread without opening SQLite manually
- blocked or failed active-thread work is visible from the CLI
- live monitoring works through `inspect --watch`
- the feature remains read-only and does not overlap with replay or admin mutation

