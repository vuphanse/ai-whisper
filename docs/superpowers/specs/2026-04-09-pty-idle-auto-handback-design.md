# PTY Idle Auto-Handoff/Handback Design

**Date:** 2026-04-09
**Branch:** feat/turn-owned-mounted-relay-handoff

## Goal

Make the baton-pass relay workflow fully autonomous. When a mounted session has been idle for 30s, it acts on whatever handoff state it is in — either accepting a pending handoff (if it has no active task) or handing back a completed result (if it has finished working). This closes the loop without any manual keypress.

Full autonomous cycle:
1. Codex sends handoff "review specs" to Claude
2. Claude's session is idle → auto-accepts, injects request into provider
3. Claude works on it; provider goes quiet for 30s
4. Claude auto-handbacks with captured response + `captureStatus`
5. Codex receives handback (orchestrator layer evaluates `captureStatus` to decide next step)

## Idle Definition

The session is considered idle when **no activity** has occurred for `IDLE_THRESHOLD_MS`. One value governs both auto-accept and auto-handback.

Resolved at session start from env var `AI_WHISPER_IDLE_THRESHOLD_MS` (parsed as integer ms), falling back to 30 000. This allows test harnesses and probe scripts to use short thresholds (e.g. 2 000 ms) without changing production defaults.

Activity resets the clock:
- Any provider PTY output chunk (`onProviderOutput`)
- Any user keystroke routed through `live-session.ts` (`processChunk`)
- Handoff accept (clock resets so the 30s starts fresh per task)

Rationale: long-running tasks (compilations, code-gen) typically stream progress text or elapsed timers, keeping the clock alive. True idle means the provider has returned to prompt and the user is not typing.

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
- Resets `lastActivityAt` and `autoAcceptFired` guard (accept already does this)
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
| `"ok"` | `turnCapture` confidence is `"high"` AND `clipboardText` non-empty AND they substantially overlap | `clipboardText` |
| `"no_response_captured_confidently"` | Signals exist but overlap check fails or `turnCapture` confidence is `"low"` | `""` |
| `"no_response_captured"` | Both `turnText` and `clipboardText` are empty/null | `""` |

**Overlap check**: `clipboardText` contains a significant substring of `turnText`, or vice versa (minimum 80 chars or 50% of the shorter string, whichever is less).

`captureStatus` is a first-class field on `handoffBackRelay` — not embedded in `requestText` — so the orchestrator layer can branch on it independently of the response content.

### Guard Details

- **Double-fire guard**: `autoHandbackFired` set true when fires. Resets when a new handoff is accepted.
- **Race guard**: after `/copy` capture completes (async), re-check `getAcceptedHandoff()` before calling `handoffBackRelay`. If handoff was declined or cancelled during capture, abort silently.
- **Composer guard**: check `isPausedInput?.() !== true` before firing. Manual `h` flow wins if composer already open.

## Idle Timer Loop

Both auto-accept and auto-handback are checked in the existing `ownerRefreshTimer` (1s interval) in `mount-session-main.ts`, after `refreshOwnerView()`:

```
if (Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS) {
  await mountedTurnRelay.checkIdleActions();
}
```

`checkIdleActions()` internally runs auto-accept check first, then auto-handback check. Only one fires per tick.

## Changes by File

### `packages/cli/src/runtime/mounted-turn-owned-relay.ts`

- Accept `idleThresholdMs: number` in input (no default — caller always passes it).
- Add `autoAcceptFired` flag (per-handoff, reset on new pending handoff or decline).
- Add `autoHandbackFired` flag (per-handoff, reset on accept).
- Add `isPausedInput?: () => boolean` to input type — provided by `mount-session-main.ts` via `() => liveSession.isPaused()`.
- Add `onHandoffAccepted?: () => void` to input type — called from `acceptPendingHandoff()` so `mount-session-main.ts` can reset `lastActivityAt`.
- Update `BrokerLike.control.handoffBackRelay` params: add `captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- New method `checkIdleActions()`:
  - If `getPendingHandoff()` returns a handoff with `status === "pending"` and `autoAcceptFired === false` and not paused → call `acceptPendingHandoff()`, set `autoAcceptFired = true`, return.
  - Else if `getAcceptedHandoff()` non-null and `autoHandbackFired === false` and not paused → run auto-handback flow.
- Auto-handback flow (inside `checkIdleActions`):
  1. Set `autoHandbackFired = true`.
  2. Call `captureHandbackText?.()` for clipboard text.
  3. Call `turnCapture?.extractLatestAssistantTurn()` for turn text.
  4. Classify confidence → `captureStatus`.
  5. Re-check `getAcceptedHandoff()` still valid; abort if null.
  6. Call `handoffBackRelay` with `requestText` and `captureStatus`.
  7. Call `turnCapture?.reset()`.
- `acceptPendingHandoff()`: set `autoHandbackFired = false`, call `onHandoffAccepted?.()`.
- `declinePendingHandoff()`: reset `autoAcceptFired = false` (allow re-evaluation if a new handoff arrives).

### `packages/cli/src/runtime/mount-session-main.ts`

- Resolve `idleThresholdMs = Number(process.env.AI_WHISPER_IDLE_THRESHOLD_MS ?? "") || 30_000` at session start.
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
- Call `onActivity?.()` at the top of `processChunk` when `sanitized.length > 0` (before gate checks, so even blocked input resets the clock).
- Add `isPaused(): boolean` to return type, returning `pausedInputDepth > 0`.

### Broker schema (`@ai-whisper/broker`)

- `handoffBackRelay` record: add optional `captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured"`.
- Surface `captureStatus` in `getRelayHandoff` return type and inspect output.

## Out of Scope

- Per-session idle threshold override beyond env var (e.g. broker-level config).
- Auto-accept for deferred handoffs — deferred means the owner explicitly postponed it, so auto-accept should not override that decision.
- Orchestrator evaluation of `captureStatus` and forward/re-issue logic (next phase).
- Any UI feedback during autonomous actions (silent by design).
