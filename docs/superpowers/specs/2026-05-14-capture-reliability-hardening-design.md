# Capture Reliability Hardening Design

**Date:** 2026-05-14
**Branch:** spec/capture-reliability-hardening

## Relationship to Prior Specs

Extends:

- [`2026-04-09-pty-idle-auto-handback-design.md`](2026-04-09-pty-idle-auto-handback-design.md) — defines the auto-handback boundary and `captureStatus` field that this spec instruments.
- [`2026-04-09-relay-orchestrator-agent-design.md`](2026-04-09-relay-orchestrator-agent-design.md) — defines the orchestrator that consumes `captureStatus` and decides whether to call the LLM or force a re-issue.

Does **not** change:

- The orchestrator's verdict vocabulary (`done` / `loop` / `escalate`).
- The `captureStatus` field on `relay_handoff` rows — `"ok"`, `"no_response_captured_confidently"`, `"no_response_captured"`.
- The manual handback flow (`h` / `Ctrl+H` / composer fallback).
- The autonomous handoff state machine.

## Problem

Every autonomous chain depends on auto-handback capture. When capture returns `no_response_captured` or `no_response_captured_confidently`, the orchestrator forces a re-issue without calling the LLM (see `README.md#capture-status`). Forced re-issues count toward `maxRounds`, so capture failures cascade into chain escalation even when the provider actually produced a valid response.

Two concrete symptoms observed in mounted sessions today:

1. **Short responses fail similarity.** A provider that replies "Done." or "Yes, that fix is correct" gives a clipboard < 100 chars; the PTY fallback similarity check (Jaccard ≥ 0.6 / containment ≥ 0.8) usually fails because the PTY buffer carries full-TUI cursor-positioned output that `normalizeCapturedOutput` cannot reconstruct.
2. **`/copy` picker timing.** Claude Code's `/copy` opens a picker; the `confirmPicker` hook fires once after `triggerDelayMs`, then polls 10× at 100 ms intervals. If the picker takes longer to appear than `triggerDelayMs`, the picker confirmation lands on the wrong UI state and the clipboard never updates.

The current debug surface (`AI_WHISPER_DEBUG_CAPTURE` env var → one JSON file per capture) is unusable post-hoc. Once a chain escalates, there is no record of *why* capture failed, only *that* it did.

We need to harden capture so that:

- Failures are visible after the fact, with enough context to tune.
- Each provider's quirks are handled by a provider-specific capture strategy rather than a single classifier with workaround heuristics.
- PTY-only captures (no clipboard change) can succeed when the PTY text is unambiguously the assistant turn.

## Phasing

This spec splits the work into three phases that ship independently. Each phase is verifiable on its own without depending on later phases.

### Phase 1 — Capture diagnostics (observability)

Persist a row per auto-handback capture attempt to a new sidecar table. Surface the data through `whisper collab inspect --captures` and via SQL for ad-hoc analysis.

**Goal:** make failure modes visible without env-flag dance, with enough fidelity that Phase 2 and Phase 3 can be tuned from real numbers instead of guesses.

#### Schema — `relay_capture_diagnostics`

| Column | Type | Notes |
|---|---|---|
| `capture_id` | TEXT PRIMARY KEY | `capture_<iso8601>_<short-handoffid>` |
| `handoff_id` | TEXT NOT NULL | FK to `relay_handoff.handoff_id`. Indexed. |
| `collab_id` | TEXT NOT NULL | Indexed. Same value as the handoff's collab. |
| `chain_id` | TEXT | Nullable: manual handoffs have no chain. Indexed when present. |
| `workflow_id` | TEXT | Nullable: non-workflow chains. |
| `target_provider` | TEXT NOT NULL | `"codex"` or `"claude"` — the agent that produced the captured response. |
| `capture_status` | TEXT NOT NULL | `"ok"` / `"no_response_captured_confidently"` / `"no_response_captured"`. |
| `clip_len` | INTEGER NOT NULL | `clipboardText?.length ?? 0`. |
| `turn_len` | INTEGER NOT NULL | `turnResult.text?.length ?? 0`. |
| `turn_confidence` | TEXT NOT NULL | `"high"` / `"low"` from `extractLatestAssistantTurn`. |
| `jaccard_score` | REAL | Nullable when not computed (clip ≥ 100 short-circuit). |
| `containment_score` | REAL | Nullable in the same cases as `jaccard_score`. |
| `clip_sample` | TEXT | First 200 chars of clipboard text. NULL when `AI_WHISPER_NO_CAPTURE_SAMPLES=1`. |
| `turn_sample` | TEXT | First 200 chars of normalized PTY turn text. NULL when `AI_WHISPER_NO_CAPTURE_SAMPLES=1`. |
| `aborted_by_race_guard` | BOOLEAN NOT NULL DEFAULT 0 | True when the post-capture race guard fired (different handoff became accepted mid-capture). Row is recorded anyway. |
| `created_at` | TEXT NOT NULL | ISO-8601 timestamp. |

Indexes: `(collab_id, created_at)`, `(handoff_id)`, `(chain_id, created_at)`, `(capture_status)`.

**Recording order:** the goal is to record every classify result, including ones where the race guard prevents the actual handback write. To keep this to a single INSERT (no UPDATE-after-write), the mounted runtime evaluates the race guard **synchronously** between `classifyCapture` and the diagnostic write:

```ts
const classification = classifyCapture(turnResult, clipboardText);
const aborted = getAcceptedHandoff()?.handoffId !== accepted.handoffId;

input.broker.control.recordCaptureDiagnostic?.({
    handoffId: accepted.handoffId,
    captureStatus: classification.status,
    jaccardScore: classification.jaccardScore,
    containmentScore: classification.containmentScore,
    abortedByRaceGuard: aborted,
    /* ... lengths, samples, timestamps ... */
});

if (aborted) return;
input.broker.control.handoffBackRelay?.({ /* ... */ });
```

The race-guard check is already synchronous (just a property comparison on the in-memory handoff record), so reordering does not introduce a window. Phase 1 tests cover both branches: a row appears with `aborted_by_race_guard = 1` when the guard fires, and with `0` when the handback proceeds.

**Privacy:** samples (`clip_sample`, `turn_sample`) are recorded by default. Setting `AI_WHISPER_NO_CAPTURE_SAMPLES=1` at broker start writes NULL into both sample columns; lengths and scores are still recorded. The opt-out covers the operator's threat model where the workspace runs against a remote workspace with sensitive context.

#### Recording flow

`createMountedTurnOwnedRelay`'s auto-handback path already computes everything we need before calling `broker.control.handoffBackRelay`. Add one call right after `classifyCapture` returns:

```ts
input.broker.control.recordCaptureDiagnostic?.({
    handoffId: accepted.handoffId,
    collabId: input.collabId,
    targetProvider: input.currentAgent,
    captureStatus,
    clipText: clipboardText,
    turnText: turnResult.text,
    turnConfidence: turnResult.confidence,
    jaccardScore: /* compute once, share with classifier */,
    containmentScore: /* same */,
    now,
});
```

`classifyCapture` is refactored to return the scores it computed so the diagnostic write doesn't duplicate work:

```ts
function classifyCapture(turn, clip): {
    status: CaptureStatus;
    jaccardScore: number | null;
    containmentScore: number | null;
}
```

#### CLI surface

Add `whisper collab inspect --captures` flag:

- `--captures` (no value): show the most recent 20 capture rows for the active collab, newest first (reverse chronological), with status, clip/turn lengths, and similarity scores. Newest-first is the right default for operator triage — the most recent failure is the one the operator is reacting to.
- `--captures <chain_id>`: filter to one chain (also newest first).
- `--captures all`: dump every row for the active collab (newest first; gated by `--workspace`).

Output is a fixed-column table; long sample text is truncated to 60 chars in the inspect view (full text in DB). This is operator triage, not a permanent UI.

`--watch` composes with `--captures`: `whisper collab inspect --captures --watch` redraws on a 1-second interval (same cadence as the existing `inspect --watch`), tailing new rows. Implementation reuses the existing inspect-watch loop; the renderer switches between "active thread" and "captures" views based on whether `--captures` is set.

#### Retention

There is no broker-side SQL sweep today: `BrokerArtifactService.sweep()` operates on CLI-side artifact directories, and `WorkflowDriver`'s `sweepIntervalMs` is workflow-specific. Phase 1 introduces a new broker-side sweep timer:

- **New file:** `packages/broker/src/runtime/diagnostics-sweep.ts` exporting `createDiagnosticsSweep({ db, intervalMs, retentionDays })` with `start()` / `stop()` methods. Default interval 1 hour; default retention 30 days; both env-overridable (`AI_WHISPER_DIAGNOSTICS_SWEEP_MS`, `AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS`).
- **Wiring:** `createBrokerRuntime` instantiates the sweep alongside `WorkflowDriver` and calls `start()` on it. `stop()` runs in the existing broker shutdown path.
- **Operation:** one `DELETE FROM relay_capture_diagnostics WHERE created_at < ?` per tick.
- **Scope creep:** the new module is named `diagnostics-sweep` rather than `capture-diagnostics-sweep` so future SQL retention work (e.g. expired chains, stale evaluator-cache rows) can share the same timer without renames.

Tests cover: sweep deletes rows older than `retentionDays`; sweep preserves recent rows; sweep tick honours `intervalMs`; `stop()` cancels pending ticks cleanly.

#### Tests (Phase 1)

- Repository round-trip: insert + query by `handoff_id`, `chain_id`, `collab_id`.
- Indexes exist after migration.
- `classifyCapture` exposes scores in the refactored return.
- `recordCaptureDiagnostic` is called once per auto-handback path (existing relay tests get extended; no new file needed).
- `inspect --captures` formatter renders all three statuses correctly.

#### Risks (Phase 1)

- **Sample text contains user-sensitive content.** 200-char cap is a deliberate trade-off — short enough that accidental disclosure is bounded, long enough to recognize what was captured. Operators with strict requirements set `AI_WHISPER_NO_CAPTURE_SAMPLES=1`; lengths and scores still record so the diagnostics remain useful.
- **Schema migration.** SQLite migration must be additive and idempotent; sidecar table avoids touching `relay_handoff`. Migration framework in `packages/broker/src/storage` already supports versioned migrations.
- **Sweep timer interacts with WorkflowDriver shutdown.** Both timers need clean stop on broker shutdown. Tests cover `stop()` cancellation; CI failures here would surface as hanging vitest processes, which we already monitor.

### Phase 2 — Provider-specific capture strategies

Replace the single capture pipeline with per-provider strategies plugged into `createMountedTurnOwnedRelay`. The mounted runtime already knows `currentAgent`; route capture through an adapter-supplied strategy instead of the hard-coded `captureHandbackText` callback and the separate `turnCapture` object.

The strategy **owns its own PTY buffer**. Today the mounted runtime feeds output to `assistant-turn-capture.ts` (a single generic implementation) and the strategy would only see post-normalization text — too late for provider-specific scraping. Moving buffering into the strategy lets Claude and Codex strategies preserve raw escape sequences that each one wants to interpret differently.

#### Interface (lives in `packages/shared`)

```ts
// packages/shared/src/capture-strategy.ts

export type CaptureStatus = "ok" | "no_response_captured_confidently" | "no_response_captured";

export interface CaptureContext {
    /** Trigger the provider's copy-to-clipboard equivalent (e.g. type `/copy` Enter). */
    triggerCopy(): void | Promise<void>;
    /** Send arbitrary input to the provider's stdin. Used for picker confirmation, ESC, etc. */
    sendInput(text: string): void | Promise<void>;
    /** Read the host clipboard (pbpaste on macOS, etc.). */
    readClipboard(): Promise<string>;
    /** Sleep helper — strategy-controlled timing. */
    sleep(ms: number): Promise<void>;
}

export interface TurnExtraction {
    confidence: "high" | "low";
    text: string | null;
}

export interface CaptureClassification {
    status: CaptureStatus;
    jaccardScore: number | null;
    containmentScore: number | null;
    /** Phase 3 field: which source produced the accepted text. */
    captureSource: "clipboard" | "pty_fallback" | "none";
}

export interface CaptureStrategy {
    /** Identifier for diagnostics + selection (matches `currentAgent`). */
    readonly target: "codex" | "claude";

    /** Buffer provider stdout. Called on every PTY data chunk. */
    recordProviderOutput(chunk: string): void;

    /** Mark the end of the current assistant turn so the next extract can return high confidence. */
    finishAssistantTurn(): void;

    /** Returns the latest completed assistant turn from the strategy's own buffer. */
    extractLatestAssistantTurn(): TurnExtraction;

    /** True if there is visible assistant output (used by manual handback fallback). */
    hasVisibleAssistantTurn(): boolean;

    /** Reset internal state between turns. */
    reset(): void;

    /** Run the clipboard capture pipeline with all the hooks the strategy needs. */
    captureClipboard(ctx: CaptureContext): Promise<string | null>;

    /** Classify the combined result. Strategy owns its similarity thresholds and the `>=100` short-circuit. */
    classify(turn: TurnExtraction, clipText: string | null): CaptureClassification;
}
```

Two implementations:

- `createClaudeCaptureStrategy()` — implements `captureClipboard` with picker confirmation (sends Enter after `triggerDelayMs` via `ctx.sendInput("\r")`); `recordProviderOutput` strips full-TUI cursor positioning; `extractLatestAssistantTurn` returns `low` confidence aggressively because Claude Code's TUI defeats similarity; `classify` keeps the existing `clip >= 100` short-circuit.
- `createCodexCaptureStrategy()` — `captureClipboard` triggers Codex's copy mechanism without picker; `recordProviderOutput` preserves line-oriented output; `extractLatestAssistantTurn` can return `high` confidence reliably; `classify` uses tighter similarity thresholds.

#### Package layout

- **Interface:** `packages/shared/src/capture-strategy.ts`, re-exported from `packages/shared/src/index.ts`. Lives in shared because both adapters implement it and CLI consumes it; this avoids a CLI → adapter dependency for type imports.
- **Claude implementation:** `packages/adapter-claude/src/capture-strategy.ts`, exported as `createClaudeCaptureStrategy()`.
- **Codex implementation:** `packages/adapter-codex/src/capture-strategy.ts`, exported as `createCodexCaptureStrategy()`.
- **Selection:** `packages/cli/src/runtime/providers.ts` gets a new `createCaptureStrategyForTarget(target)` that returns the implementation matching the current agent. Mounted runtime receives the strategy as a constructor arg.

#### Migration path

The mounted runtime's `captureHandbackText` + `turnCapture` parameters collapse into a single `captureStrategy: CaptureStrategy`:

```ts
// before
createMountedTurnOwnedRelay({
    captureHandbackText: () => captureClipboardHandback({ triggerCopy, confirmPicker, ... }),
    turnCapture: createAssistantTurnCapture(),
    ...
});

// after
createMountedTurnOwnedRelay({
    captureStrategy: createCaptureStrategyForTarget(currentAgent),
    ...
});
```

`assistant-turn-capture.ts` stays in the repo as a building block — the Claude strategy can compose it for the parts it shares with the existing pipeline — but its direct use from the mounted runtime is removed. The generic `clipboard-handback-capture.ts` is repurposed as a utility the strategies can compose; it stops being the primary capture path.

Existing relay tests that pass a mock `captureHandbackText`/`turnCapture` get rewritten to pass a `MockCaptureStrategy` with the same observable behavior. Diagnostics rows record `target_provider` from `strategy.target`, so the value is always correct.

#### Tests (Phase 2)

- Each strategy unit-tested against canned PTY buffers per provider (real captured logs added to `test/fixtures/`).
- Integration: mounted runtime + Claude strategy produces correct classification on full-TUI sample; same for Codex on prompt-return sample.
- Regression: existing mounted relay tests continue to pass with the shim.

#### Risks (Phase 2)

- **Strategy divergence.** Two strategies × evolution = drift. Mitigated by a shared test harness that runs both against the same canonical scenarios (short response, long response, no response, picker timeout, slow clipboard).
- **Wrong strategy selection.** `currentAgent` is the source of truth; if it's ever wrong we have bigger problems. No additional guard needed.

### Phase 3 — PTY fallback path

Today PTY text only validates clipboard. Promote it to a fallback: when `captureClipboard` returns null, but `extractTurnText` returns `{ confidence: "high", text }` with `text.length >= MIN_PTY_FALLBACK_LEN`, classify as `ok` and use the PTY text as the handback payload.

#### Classifier extension

```ts
classify(turn, clip):
    if clip is non-empty:
        # existing logic
    elif turn.confidence === "high" && turn.text.length >= MIN_PTY_FALLBACK_LEN:
        return "ok"  # with capture_source: "pty_fallback" in diagnostics
    else:
        return "no_response_captured"
```

`MIN_PTY_FALLBACK_LEN` defaults to `50`. Tunable via Phase 1 diagnostics — start conservative.

A new diagnostic column `capture_source TEXT DEFAULT NULL` records `"clipboard"`, `"pty_fallback"`, or `"none"`. Required to distinguish which path succeeded in the data.

The Phase 3 migration is additive and nullable: existing Phase 1 rows keep `capture_source = NULL`. Application code reads `capture_source` as `null` for pre-Phase-3 rows and presents them as "unknown" in `inspect --captures`. No backfill required.

The `CaptureClassification` interface in Phase 2 already includes `captureSource: "clipboard" | "pty_fallback" | "none"`, so by the time Phase 3 ships the field is already being produced — Phase 3 just persists it.

#### Provider applicability

PTY fallback is only safe for providers whose strategy returns reliable `high`-confidence text. Codex strategy supports it; Claude strategy returns `low` confidence by design (TUI), so PTY fallback is effectively disabled there. The capability is gated by the strategy itself, not a separate flag.

#### Tests (Phase 3)

- PTY fallback path activated when clipboard returns null + PTY text ≥ threshold.
- PTY fallback rejected when text is below threshold.
- PTY fallback rejected when strategy returns `low` confidence (Claude case).
- Diagnostic `capture_source` field populated correctly across all paths.

#### Risks (Phase 3)

- **Stale PTY content captured as new turn.** The `finishAssistantTurn` boundary already guards against mid-stream extraction. If PTY fallback returns ancient text from a previous turn, we have a deeper bug — Phase 1 diagnostics will catch this via `turn_sample`.
- **PTY noise polluting the handback payload.** Possible if normalization misses sequences. Mitigated by Codex strategy's normalizer being stricter than the current generic one.

## Non-Goals

- New verdict types or orchestrator branching changes.
- Manual handback flow modifications.
- Cross-provider capture (e.g. capturing from one provider in another's mount).
- Auto-tuning of `IDLE_THRESHOLD_MS` based on capture timing.
- Replacing the `relay_handoff.capture_status` field with a numeric confidence ladder (deferred; needs Phase 1 data to motivate).

## Out-of-Scope Improvements (Considered, Deferred)

- **Next-prompt-return turn detection.** Instead of relying on idle threshold, detect when the provider's prompt redraws after a turn. More robust but requires deep adapter changes and a way to anchor the prompt regex per provider. Revisit if Phase 1 data shows turn-boundary errors dominate.
- **Confidence ladder.** A numeric score (0..1) the orchestrator could weight against verdict confidence. Easier to reason about than three discrete states but breaks the existing orchestrator contract. Defer until we have data on whether the three-state model is the bottleneck.
- **Capture-failure escalation tuning.** Currently 3 forced re-issues then escalate. Could differentiate "provider produced nothing" from "we failed to capture". Phase 1 data will tell us if this matters.

## Resolved Decisions

- **Sample privacy:** samples on by default; `AI_WHISPER_NO_CAPTURE_SAMPLES=1` opts out at broker start. Reflected in Phase 1 schema (`clip_sample`/`turn_sample` nullable) and acceptance.
- **Interface home:** `CaptureStrategy` lives in `packages/shared`. Adapters implement, CLI consumes the type, no CLI → adapter dependency.
- **Strategy buffer ownership:** the strategy owns its own PTY buffer (`recordProviderOutput` / `finishAssistantTurn` / `extractLatestAssistantTurn` move from `assistant-turn-capture.ts` into the strategy contract). Required so Claude and Codex strategies can normalize differently from raw bytes; the prior assumption that strategies could work from a `rawBuffer: string` argument was unsound because the mounted runtime never holds raw bytes outside the strategy.
- **Picker confirmation:** `CaptureContext.sendInput(text)` is part of the Phase 2 interface, so strategies can fire Enter or other keys for picker-driven providers without a separate `confirmPicker` callback path.
- **Diagnostics recording point:** every classify result is recorded, including aborted ones. To keep this to a single INSERT, the race guard is evaluated synchronously between `classifyCapture` and the diagnostic write, and its result is stored in the `aborted_by_race_guard` column. Aborted attempts are recorded with `aborted_by_race_guard = 1` and do not call `handoffBackRelay`. See "Recording order" in Phase 1 for the code sketch.
- **Retention:** 30-day sweep on `relay_capture_diagnostics`, performed by a new broker-side `diagnostics-sweep` timer (no existing SQL sweep to piggyback on). Hourly cadence; env-overridable.
- **Watch mode:** `inspect --captures --watch` ships with Phase 1, sharing the existing inspect-watch redraw loop.

## Open Questions

_None remaining for Phase 1. Phase 2 / Phase 3 may surface adapter-specific tuning questions once Phase 1 diagnostics produce real data._

## Acceptance

This work is done when:

- **Phase 1:** every auto-handback writes a `relay_capture_diagnostics` row (race guard evaluated synchronously before the write so the row carries the correct `aborted_by_race_guard` flag); `AI_WHISPER_NO_CAPTURE_SAMPLES=1` causes `clip_sample` and `turn_sample` to be NULL while all other fields still record; `whisper collab inspect --captures` renders the last 20 captures for the active collab; `whisper collab inspect --captures --watch` redraws at the existing inspect-watch cadence; the new broker-side `diagnostics-sweep` timer deletes `relay_capture_diagnostics` rows older than 30 days at hourly cadence (both env-overridable); 100% of `pnpm test` green; no schema migration churn between dev and CI.
- **Phase 2:** Claude and Codex captures route through provider-specific strategies; the `CaptureStrategy` interface is imported by both adapters from `@ai-whisper/shared`; both strategies have fixture-based unit tests covering short response / long response / no response / picker timeout / slow clipboard; the generic `clipboard-handback-capture.ts` path is repurposed as a strategy utility, not the primary capture path; existing manual-handback flow is unchanged.
- **Phase 3:** PTY fallback succeeds on Codex-shaped scenarios where clipboard returns null but PTY has high-confidence text; Phase 1 diagnostics show the new `capture_source` value populated (NULL for pre-Phase-3 rows); no regressions in existing capture paths.

## Estimated Sizing

| Phase | Files touched | New code | Risk |
|---|---|---|---|
| 1 — diagnostics | ~8 (broker repo + migration + control method + cli runtime + inspect CLI + sweep module + sweep wiring + tests) | ~400 lines | Low |
| 2 — strategies | ~8 (2 adapters + shared interface + mounted runtime + tests + fixtures) | ~500 lines | Medium |
| 3 — PTY fallback | ~3 (classifier + strategy fields + tests) | ~150 lines | Low |
