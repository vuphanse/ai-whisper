# PTY Idle Auto-Handback Design

**Date:** 2026-04-09
**Branch:** feat/turn-owned-mounted-relay-handoff

## Goal

When the owner side of a mounted turn-owned relay goes quiet after accepting a handoff, automatically hand back to the sender without requiring the owner to press `h`. This reduces friction in the baton-pass workflow and gives the orchestrator layer structured metadata to decide how to handle the result.

## Idle Definition

The session is considered idle when **no activity** has occurred for `IDLE_AUTO_HANDBACK_MS` (default: 30 000 ms).

Activity resets the clock:
- Any provider PTY output chunk (`onProviderOutput`)
- Any user keystroke routed through `live-session.ts` (`processChunk`)
- Handoff accept (clock resets to `Date.now()` so the 30s starts fresh per task)

Rationale: long-running tasks (compilations, code-gen) typically stream progress text or elapsed timers, which keep the clock alive. True idle means the provider has returned to prompt.

## Trigger Condition

Auto-handback fires when all of the following are true:

1. An accepted handoff exists (`getAcceptedHandoff()` returns non-null)
2. `Date.now() - lastActivityAt >= IDLE_AUTO_HANDBACK_MS`
3. Composer is not currently open (`pausedInputDepth === 0` in live-session)
4. Per-handoff guard flag `autoHandbackFired` is false

## Capture and Confidence Check

Two signals are collected after idle is detected:

| Signal | Source |
|--------|--------|
| `turnText` | `turnCapture.extractLatestAssistantTurn()` — output recorded since handoff accept |
| `clipboardText` | `captureHandbackText()` — injects `/copy` into provider session, reads clipboard |

Confidence classification:

| `captureStatus` | Condition | `requestText` |
|-----------------|-----------|---------------|
| `"ok"` | `turnCapture` confidence is `"high"` AND `clipboardText` non-empty AND they substantially overlap | `clipboardText` |
| `"no_response_captured_confidently"` | Signals exist but overlap check fails or `turnCapture` confidence is `"low"` | `""` |
| `"no_response_captured"` | Both `turnText` and `clipboardText` are empty/null | `""` |

**Overlap check**: `clipboardText` contains a significant substring of `turnText`, or vice versa (minimum 80 chars or 50% of the shorter string, whichever is less).

`captureStatus` is a first-class field on `handoffBackRelay` — not embedded in `requestText` — so the orchestrator layer can branch on it independently of the response content.

## Guard Details

- **Double-fire guard**: `autoHandbackFired` flag is set true when auto-handback triggers. Resets when a new handoff is accepted.
- **Race guard**: after `/copy` capture completes (async), re-check `getAcceptedHandoff()` before calling `handoffBackRelay`. If the handoff was declined or cancelled during capture, abort silently.
- **Composer guard**: check `pausedInputDepth > 0` before firing. If the owner manually opened `h` while idle was detected, the manual flow wins.

## Changes by File

### `packages/cli/src/runtime/mounted-turn-owned-relay.ts`

- Add `IDLE_AUTO_HANDBACK_MS = 30_000` constant.
- Add `autoHandbackFired` flag (per-handoff, reset on accept).
- Add `isPausedInput?: () => boolean` to input type — provided by `mount-session-main.ts` via `() => liveSession.isPaused()`.
- Add `onHandoffAccepted?: () => void` to input type — called from `acceptPendingHandoff()` so `mount-session-main.ts` can reset `lastActivityAt`.
- Update `BrokerLike.control.handoffBackRelay` params: add `captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- New method `autoHandbackOnIdle()`:
  1. Check accepted handoff exists; noop if not.
  2. Check `autoHandbackFired === false`; noop if already fired.
  3. Check `isPausedInput?.() !== true`; noop if composer open.
  4. Set `autoHandbackFired = true`.
  5. Call `captureHandbackText?.()` for clipboard text.
  6. Call `turnCapture?.extractLatestAssistantTurn()` for turn text.
  7. Classify confidence → `captureStatus`.
  8. Re-check `getAcceptedHandoff()` still valid; abort if null.
  9. Call `handoffBackRelay` with `requestText` and `captureStatus`.
  10. Call `turnCapture?.reset()`.
- `acceptPendingHandoff()`: set `autoHandbackFired = false`, call `onHandoffAccepted?.()`.

### `packages/cli/src/runtime/mount-session-main.ts`

- Add `lastActivityAt: number = Date.now()`.
- Reset `lastActivityAt` in:
  - `interactiveSession.onProviderOutput` handler
  - `onActivity` callback passed into `createLiveSessionRuntime`
  - `onHandoffAccepted` callback passed into `createMountedTurnOwnedRelay`
- In `ownerRefreshTimer` (existing 1s loop), after `refreshOwnerView()`:
  ```
  if (Date.now() - lastActivityAt >= IDLE_AUTO_HANDBACK_MS) {
    await mountedTurnRelay.autoHandbackOnIdle();
  }
  ```
- Pass `isPausedInput: () => liveSession.isPaused()` into `createMountedTurnOwnedRelay`.

### `packages/cli/src/runtime/live-session.ts`

- Accept optional `onActivity?: () => void` in input.
- Call `onActivity?.()` at the top of `processChunk` when `sanitized.length > 0` (before gate checks, so even blocked input resets the clock).
- Add `isPaused(): boolean` to return type, returning `pausedInputDepth > 0`.

### Broker schema (`@ai-whisper/broker`)

- `handoffBackRelay` record: add optional `captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- Surface `captureStatus` in `getRelayHandoff` return type and inspect output.

## Out of Scope

- Configurable idle threshold per session (always 30s for now).
- Auto-handback when handoff is deferred (only fires on accepted).
- Any UI feedback during the auto-handback (silent by design).
