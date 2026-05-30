# Codex Bracketed-Paste Prompt Injection Design

**Date:** 2026-05-30
**Branch:** spec/codex-bracketed-paste-injection
**Status:** Draft — spike-validated, ready for implementation review

## Relationship to Prior Specs / Docs

- **Finding:** `docs/superpowers/notes/2026-05-30-codex-pty-prompt-injection-sluggishness.md`
  — diagnosis (codex-confirmed) that the codex submit path is char-by-char
  throttled, and the spike that validated bracketed paste against real codex
  v0.135.0.
- **Capture Reliability Hardening** (`2026-05-14-capture-reliability-hardening-design.md`)
  introduced per-provider *capture* strategies (response → clipboard). This spec
  is the symmetric counterpart for the *submit/inject* direction (prompt →
  codex composer). Same principle: provider-specific behavior behind a seam,
  selected at runtime.

## Problem

The mounted relay injects the inter-agent handoff prompt into codex's TUI **one
character at a time with a 5 ms sleep between every char**
(`packages/cli/src/runtime/provider-submit-strategy.ts:11-21`), then submits
with a bare `\r`. Claude uses a single whole-string write.

Cost is linear in prompt length: `len × 5 ms + 100 ms`. Workflow handoff
prompts are multi-KB, so a 6,000-char prompt costs ~30 s of pure typing delay
before submit; 10,000 chars ≈ 50 s. This is the observed sluggishness.

The drip exists as a reliability band-aid (inline comment: codex "least reliable
when large chunks are pasted at once"). It treats the symptom (input too fast)
rather than the cause (wrong delivery channel — simulated keystrokes instead of
a paste). It was introduced fully-formed in `f9b782c` and never iterated.

## Spike evidence (2026-05-30, codex v0.135.0)

A throwaway `node-pty` spike (mirroring the real mount spawn) established:

- Codex **enables bracketed-paste mode** at the ready composer — emits
  `ESC[?2004h`.
- A **single atomic write** of `ESC[200~ <text> ESC[201~` is accepted intact:
  - Small multi-line payload → lands in the composer, newlines literal, **no
    premature submit**.
  - **10,186-char / 70-line payload** → collapsed to a `[Pasted Content 10186
    chars]` chip (codex's large-paste handling), intact, no garbling, no
    premature submit.
- A single `\r` on a separate beat submits **the whole block as one message**.
- Incidental but important: codex **silently drops input when it is NOT at a
  ready composer** (directory-trust prompt, MCP-server boot). A single atomic
  write sent before-ready is lost entirely; the keystream drip would at least
  land its tail. `ESC[?2004h` being currently enabled doubles as a
  composer-ready signal.

Conclusion: bracketed paste is fast and reliable; the drip is unnecessary. But
the fix must (a) not assume bracketed paste is permanent, and (b) only fire when
codex is actually ready.

## Design

### Core: selectable submit strategy with auto-detect + override

Keep `submitInjectedProviderInput` as the single submit seam, but make the codex
behavior a **named, selectable strategy** rather than a hardcoded loop. Three
strategies retained in-tree permanently:

| strategy    | behavior                                                        |
|-------------|-----------------------------------------------------------------|
| `bracketed` | one write `ESC[200~ <text> ESC[201~`, `sleep(100)`, `\r`         |
| `keystream` | the EXISTING char-by-char 5 ms drip + `\r` (legacy fallback)     |
| `chunk`     | whole-string write + `sleep(75)` + `\r` (claude-style; optional) |

**Selection (codex):**
```
strategy = envOverride ?? (bracketedPasteEnabled ? 'bracketed' : 'keystream')
```
- `envOverride` = `AI_WHISPER_CODEX_SUBMIT_STRATEGY` ∈ {`bracketed`,`keystream`,`chunk`}.
- `bracketedPasteEnabled` = observed at runtime from the PTY output stream
  (see capability detection below).

**Why this is the no-corner-painting design:** if codex ever drops bracketed
paste, it stops emitting `ESC[?2004h`, `bracketedPasteEnabled` goes false, and
selection **auto-falls back to `keystream` with zero code change**. The override
lets an operator pin any strategy if detection is ever wrong, without a release.
The legacy keystream is never deleted — it remains the safety net.

### Capability detection (the auto part)

Codex emits `ESC[?2004h` (DECSET 2004, enable bracketed paste) when its composer
is active and `ESC[?2004l` (reset) when not. The mount already observes codex
PTY output via `interactiveSession.onProviderOutput`. Add a tiny tracker:

```
// packages/cli/src/runtime/bracketed-paste-detector.ts
export function createBracketedPasteDetector() {
  let enabled = false;
  return {
    observe(data: string) {
      // last toggle wins within the chunk
      const hi = data.lastIndexOf("\x1b[?2004h");
      const lo = data.lastIndexOf("\x1b[?2004l");
      if (hi > lo) enabled = true;
      else if (lo > hi) enabled = false;
    },
    get enabled() { return enabled; },
  };
}
```

The mount feeds every `onProviderOutput` chunk to `observe()`, and passes
`detector.enabled` into the submit call. Because codex only has 2004h active
when the composer is focused/ready, **`enabled === true` is simultaneously the
capability signal and the readiness signal** — it answers both "does codex
support paste?" and "is codex ready to receive it?". When false (booting, trust
prompt, or genuinely unsupported), we fall back to keystream, which is the more
tolerant channel for a not-fully-ready composer.

### Submit-strategy signature

```ts
export type CodexSubmitStrategy = "bracketed" | "keystream" | "chunk";

export async function submitInjectedProviderInput(input: {
  target: "codex" | "claude";
  text: string;
  writeUserInput: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  bracketedPasteEnabled?: boolean;       // from the detector; default false
  strategyOverride?: CodexSubmitStrategy; // from env; default undefined
}): Promise<void>
```

Codex branch resolves the strategy then dispatches. Claude branch is unchanged
(it already does the `chunk` behavior and has no reported issue).

`bracketed` implementation:
```ts
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// sanitize: a literal end-marker in the payload would close the paste early
const safe = input.text.split(PASTE_END).join("");
input.writeUserInput(PASTE_START + safe + PASTE_END);
await sleep(100);
input.writeUserInput("\r");
```

### Wiring

- `packages/cli/src/runtime/bracketed-paste-detector.ts` — new, as above.
- `packages/cli/src/runtime/mount-session-main.ts`:
  - construct the detector; feed `interactiveSession.onProviderOutput` chunks to
    `detector.observe(data)` (alongside the existing `turnCapture` recording).
  - read `AI_WHISPER_CODEX_SUBMIT_STRATEGY` once; validate against the union.
  - `submitInjectedInput` passes `bracketedPasteEnabled: detector.enabled` and
    `strategyOverride` into `submitInjectedProviderInput`.
- `packages/cli/src/runtime/provider-submit-strategy.ts` — strategy dispatch;
  keystream loop retained verbatim as the `keystream` branch.

## Tests

Un-skip and rewrite the Mode B guard
(`test/provider-submit-strategy.test.ts`, currently `describe.skip`,
TODO 2026-05-29) to assert the real contract:

- `bracketedPasteEnabled=true`, no override → writes exactly
  `ESC[200~ + text + ESC[201~` in a **single** `writeUserInput` call, then `\r`
  on a separate beat. NOT char-by-char.
- Multi-line `text` is delivered **literally** inside the markers (newlines
  preserved, no intermediate `\r`).
- `bracketedPasteEnabled=false`, no override → **keystream** (char-by-char drip)
  — the fallback path, asserted explicitly so the safety net can't silently rot.
- `strategyOverride='keystream'` with `bracketedPasteEnabled=true` → keystream
  (override wins).
- `strategyOverride='bracketed'` with `bracketedPasteEnabled=false` → bracketed
  (override wins).
- Payload containing a literal `ESC[201~` → sanitized so the paste isn't closed
  early.
- New unit: `bracketed-paste-detector` — `2004h` → enabled; `2004l` → disabled;
  last-toggle-wins within a chunk; default disabled.

Also drop the stale "Mode B" TODO comment now that it's a real reproduction.

## Edge cases

- **Codex toggles 2004l mid-session** (composer loses focus) → detector reports
  false → that injection uses keystream. Self-corrects on next 2004h.
- **Payload contains paste markers** → end-marker stripped (sanitize); start
  marker is harmless but strip both for symmetry.
- **Empty text** → still emit start+end+`\r` (submits empty) OR no-op; pick
  no-op to avoid an empty codex turn.
- **Very large payload** → validated to 10 KB; no known upper bound. If codex
  ever caps paste size, the detector won't catch it — covered by the override as
  the escape hatch, and a future `chunk-the-paste` enhancement noted below.
- **Non-codex target** → claude path unchanged; detector unused.

## Risks

- **Detection false-negative** (codex ready but we never saw 2004h, e.g. it was
  emitted before the mount attached) → we fall back to keystream: slow but
  correct, never broken. Acceptable degradation. Mitigation: the detector starts
  observing at mount start, before any handoff.
- **Detection false-positive** (2004h seen but codex not actually ready) →
  bracketed write could be dropped. Low risk because 2004h tracks composer
  focus; if observed in practice, the override pins keystream until fixed.
- **`[Pasted Content N chars]` chip hides content** → we cannot verify delivery
  by echo for large pastes. Accepted: submit succeeds (spike-proven). Option 3
  ("self-heal verify") was considered and rejected for this iteration as
  over-coupled to composer-render parsing.
- **Strategy drift** between bracketed/keystream/chunk → shared test scenarios
  (multi-line, large, marker-in-payload) run against each branch.

## Rollout

Single phase — the change is contained to the submit seam plus a small detector,
fully covered by unit tests, with the legacy path retained as runtime fallback.
No schema, no broker change. Ship behind the auto-detect default; the override
env var is the operator kill-switch.

Future (not in scope): `chunk-the-paste` for payloads above a configurable size
if a codex paste cap ever appears; applying the same detector pattern to claude
if it regresses.

## Open questions

- **Submit key in the live mount.** The spike used `\r` and it submitted the
  pasted block cleanly. Confirm `\r`-on-a-separate-beat still submits in the full
  mount (with the real prompt, wrapping, and any composer chrome) during
  implementation verification; if not, the submit byte is the only thing to
  adjust and it's isolated to the `bracketed` branch.
- **Should `keystream` keep the 5 ms cadence** when used as a fallback, or widen
  it? Leave as-is (verbatim) to avoid changing the proven fallback behavior.
