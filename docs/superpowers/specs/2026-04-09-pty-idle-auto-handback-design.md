# PTY Idle Auto-Handoff/Handback Design

**Date:** 2026-04-09
**Branch:** feat/turn-owned-mounted-relay-handoff

## Relationship to Prior Specs

This spec extends `2026-04-08-ai-whisper-turn-owned-mounted-relay-handoff-design.md`. It does **not** remove or replace the manual controls (`a/e/d/h`). Those remain fully functional for when a human is attending the session. This spec adds an autonomous fallback path that activates only when the session is unattended (idle). When both paths could apply, the manual flow wins (composer-open guard).

The prior spec's "fall back to blank manual composer on low-confidence extraction" applies to the **manual handback** path only. The autonomous path intentionally sends an empty payload with `captureStatus` instead of opening a composer — there is no human to fill it in. Recovery is the orchestrator's responsibility, not the relay's.

## Orchestrator Contract

`captureStatus` must be added to the orchestrator spec (`2026-04-09-relay-orchestrator-agent-design.md`) as a first-class evaluation input. The orchestrator should branch on it:
- `"ok"` → accept result, forward or continue
- `"no_response_captured_confidently"` → re-issue task or request clarification
- `"no_response_captured"` → treat as failed turn, re-issue

## Goal

Make the baton-pass relay workflow fully autonomous. When a mounted session has been idle for `IDLE_THRESHOLD_MS`, it acts on whatever handoff state it is in — either accepting a pending handoff (if it has no active task) or handing back a completed result (if it has finished working). This closes the loop without any manual keypress.

Full autonomous cycle:
1. Codex sends handoff "review specs" to Claude
2. Claude's session is idle → auto-accepts, injects request into provider
3. Claude works on it; provider goes quiet for `IDLE_THRESHOLD_MS`
4. Claude auto-handbacks with captured response + `captureStatus`
5. Codex receives handback; orchestrator evaluates `captureStatus` to decide next step

## Idle Definition

The session is considered idle when **no activity** has occurred for `IDLE_THRESHOLD_MS`. One value governs both auto-accept and auto-handback.

Resolved at session start from env var `AI_WHISPER_IDLE_THRESHOLD_MS` (parsed as integer ms), falling back to 30 000. Clamped to a minimum of 5 000 ms — values below this give insufficient confidence that the session is truly idle. Test harnesses should use 5 000–10 000 ms.

Activity resets the clock:
- Any provider PTY output chunk (`onProviderOutput`)
- Any user keystroke that **reaches the provider** — i.e. passes through both the `externalInputRouter` and `externalInputGate` checks without being consumed or blocked (see live-session changes below)
- Handoff accept (clock resets so `IDLE_THRESHOLD_MS` starts fresh per task)

Keystrokes that do **not** reset the clock:
- Keystrokes consumed by `externalInputRouter` (owner card controls: `a/e/d/h/space`)
- Keystrokes blocked by `externalInputGate` (waiting-side blocked input)

Rationale: owner card keypresses and blocked waiting-side taps are not provider activity. Resetting the clock on these would prevent autonomous flow from ever triggering during interactive or blocked sessions. Terminal noise (spinners, progress timers) does reset the clock — this is intentional, as the provider is still running.

## Auto-Accept

### Trigger Condition

Auto-accept fires when all of the following are true:

1. A pending handoff (`status === "pending"`) targeting this agent exists — deferred handoffs are excluded (owner explicitly postponed, auto-accept must not override)
2. `Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS`
3. Composer is not open (`isPausedInput?.() !== true`)
4. Per-handoff guard flag `autoAcceptFired` is false

### Behaviour

- Calls `acceptPendingHandoff()` directly (same path as pressing `a`)
- Injects the handoff `requestText` into the provider session
- Resets `lastActivityAt` via `onHandoffAccepted` callback and clears `autoHandbackFired` guard
- No owner card shown, no confirmation

## Auto-Handback

### Trigger Condition

Auto-handback fires when all of the following are true:

1. An accepted handoff exists (`getAcceptedHandoff()` returns non-null)
2. `Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS`
3. Composer is not open (`isPausedInput?.() !== true`)
4. Per-handoff guard flag `autoHandbackFired` is false

### Capture and Confidence Check

Two signals are collected after idle is detected:

| Signal | Source |
|--------|--------|
| `turnText` | `turnCapture.extractLatestAssistantTurn()` — output recorded since handoff accept |
| `clipboardText` | `captureHandbackText()` — injects `/copy` into provider session, reads clipboard |

Confidence classification:

| `captureStatus` | Condition | `requestText` |
|-----------------|-----------|---------------|
| `"ok"` | `turnCapture` confidence is `"high"` AND `clipboardText` non-empty AND ordered Jaccard score >= 0.6 | `clipboardText` |
| `"no_response_captured_confidently"` | Signals exist but score < 0.6 or `turnCapture` confidence is `"low"` | `""` |
| `"no_response_captured"` | Both `turnText` and `clipboardText` are empty/null | `""` |

**Overlap check — ordered Jaccard:**
1. Normalize both texts: trim, collapse whitespace, lowercase
2. Extract content words (length >= 4 chars) from both, preserving order
3. Compute base Jaccard: `|intersection| / |union|` on the word sets
4. Compute LCS length over the word sequences
5. Final score: `jaccard * (lcsLength / shorterSequenceLength)`
6. Score >= 0.6 → overlap confirmed

The LCS factor penalizes out-of-order matches — the same response should appear in the same word order in both signals. A perfectly ordered match scores close to 1.0; same vocabulary but scrambled order scores low.

`captureStatus` is a first-class field on `handoffBackRelay` — not embedded in `requestText` — so the orchestrator layer can branch on it independently of the response content.

### Idle Detection Limitations and Accepted Risk

Idle detection is heuristic — it cannot distinguish "provider finished and returned to prompt" from "provider is blocked waiting on user input" (permission prompt, follow-up question, login prompt, shell prompt after failed command). In all blocked cases the session goes quiet and the idle timer fires.

Accepted risk: false positives in these cases produce `"no_response_captured"` or `"no_response_captured_confidently"` status, with empty `requestText`. Any partial but valuable provider output is dropped from the chain — the orchestrator re-issues the task but prior work is not preserved in the handback. This is a real loss from the user's perspective, not just a wasted round-trip.

**Recommended setup for best autonomous flow**: mount with provider auto-allow-permissions enabled (e.g. `--dangerously-skip-permissions` for Claude, auto-approve for Codex). Permission prompts stop output, look idle to the detector, and produce false handbacks. With auto-allow, the provider keeps running and the idle clock stays alive until work is genuinely done.

### Guard Details

- **Double-fire guard**: `autoHandbackFired` and `autoAcceptFired` are stored as `string | null` (the `handoffId` they fired for), not plain booleans. On each `checkIdleActions()` call, a guard is only active if it matches the current handoff's id. A new handoff with a different id is always treated as fresh — no bleed between handoffs in the same mounted session, and reconnect/reload resets naturally since a new handoffId is assigned.
- **Capture failure contract**: the entire capture + classification block in auto-handback is wrapped in try/catch. On any exception (clipboard timeout, `/copy` failure, etc.), treat `clipboardText` as null and proceed to classification normally — likely producing `"no_response_captured"`. The guard (`autoHandbackFired`) stays set to the current handoffId after an exception; no retry for the same handoff.
- **Race guard**: after `/copy` capture completes (async), re-check `getAcceptedHandoff()` before calling `handoffBackRelay`. If handoff was declined or cancelled during capture, abort silently and do not reset guard.
- **Composer guard**: check `isPausedInput?.() !== true` before firing. If user manually opened the composer (`h` or `e`) while idle was detected, the manual flow wins.
- **Simultaneous manual + auto**: if auto fires and user presses a manual key at the same moment, the second action is a noop — guard is already set to current handoffId, or `getAcceptedHandoff()` / `getPendingHandoff()` returns null because state already transitioned. No duplicate handoff is possible.

## Idle Timer Loop

Both auto-accept and auto-handback are checked in the existing `ownerRefreshTimer` (1s interval) in `mount-session-main.ts`, after `refreshOwnerView()`:

```
if (Date.now() - lastActivityAt >= idleThresholdMs) {
  await mountedTurnRelay.checkIdleActions();
}
```

`checkIdleActions()` internally runs auto-accept check first, then auto-handback check. Only one fires per tick.

## Changes by File

### `packages/cli/src/runtime/mounted-turn-owned-relay.ts`

- Accept `idleThresholdMs: number` in input (no default — caller always passes it).
- Add `autoAcceptFiredFor: string | null` — stores the `handoffId` auto-accept fired for; null means not yet fired. Active guard = value equals current handoffId.
- Add `autoHandbackFiredFor: string | null` — same pattern for auto-handback.
- Add `isPausedInput?: () => boolean` to input type — provided by `mount-session-main.ts` via `() => liveSession.isPaused()`.
- Add `onHandoffAccepted?: () => void` to input type — called from `acceptPendingHandoff()` so `mount-session-main.ts` can reset `lastActivityAt`.
- Update `BrokerLike.control.handoffBackRelay` params: add `captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- New method `checkIdleActions()`:
  - If `getPendingHandoff()` returns a handoff with `status === "pending"` and `autoAcceptFiredFor !== handoff.handoffId` and not paused → set `autoAcceptFiredFor = handoff.handoffId`, call `acceptPendingHandoff()`, return.
  - Else if `getAcceptedHandoff()` non-null and `autoHandbackFiredFor !== handoff.handoffId` and not paused → run auto-handback flow.
- Auto-handback flow (inside `checkIdleActions`):
  1. Set `autoHandbackFiredFor = handoff.handoffId`.
  2. Wrap steps 3–7 in try/catch; on exception treat `clipboardText` as null and continue to step 6.
  3. Call `captureHandbackText?.()` for clipboard text.
  4. Call `turnCapture?.extractLatestAssistantTurn()` for turn text.
  5. Classify confidence → `captureStatus`.
  6. Re-check `getAcceptedHandoff()` still valid; abort silently if null (guard stays set).
  7. Call `handoffBackRelay` with `requestText` and `captureStatus`.
  8. Call `turnCapture?.reset()`.
- `acceptPendingHandoff()`: set `autoHandbackFiredFor = null`, call `onHandoffAccepted?.()`.
- `declinePendingHandoff()`: set `autoAcceptFiredFor = null`.

### `packages/cli/src/runtime/mount-session-main.ts`

- Resolve `idleThresholdMs = Math.max(5_000, Number(process.env.AI_WHISPER_IDLE_THRESHOLD_MS ?? "") || 30_000)` at session start.
- Add `lastActivityAt: number = Date.now()`.
- Reset `lastActivityAt` in:
  - `interactiveSession.onProviderOutput` handler
  - `onActivity` callback passed into `createLiveSessionRuntime`
  - `onHandoffAccepted` callback passed into `createMountedTurnOwnedRelay`
- In `ownerRefreshTimer`, after `refreshOwnerView()`, add:
  ```
  if (Date.now() - lastActivityAt >= idleThresholdMs) {
    await mountedTurnRelay.checkIdleActions();
  }
  ```
- Pass `isPausedInput: () => liveSession.isPaused()` and `idleThresholdMs` into `createMountedTurnOwnedRelay`.

### `packages/cli/src/runtime/live-session.ts`

- Accept optional `onActivity?: () => void` in input.
- Call `onActivity?.()` **after** both `externalInputRouter` and `externalInputGate` checks — only when the keystroke is about to be passed through to the provider. Keystrokes consumed by the router or blocked by the gate do not reset the idle clock.
- Add `isPaused(): boolean` to return type, returning `pausedInputDepth > 0`.

### Broker schema (`@ai-whisper/broker`)

- `handoffBackRelay` record: add optional `captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- Surface `captureStatus` in `getRelayHandoff` return type and inspect output.

### `docs/superpowers/specs/2026-04-09-relay-orchestrator-agent-design.md`

- Add `captureStatus` to the handback evaluation inputs.
- Define branch logic for each status value (see Orchestrator Contract section above).

## Out of Scope

- Per-session idle threshold override beyond env var (e.g. broker-level config).
- Auto-accept for deferred handoffs — deferred means the owner explicitly postponed it, so auto-accept must not override that decision.
- Any UI feedback during autonomous actions (silent by design).
