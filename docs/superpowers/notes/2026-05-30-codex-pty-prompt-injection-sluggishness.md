# Finding: codex PTY prompt injection is char-by-char throttled, not streamed

- **Date:** 2026-05-30
- **Status:** DIAGNOSIS CONFIRMED by codex (2026-05-30). Fix direction
  (bracketed paste) still needs LIVE codex validation before any change.
- **Area:** mounted relay → prompt injection into the codex live PTY
- **Reporter:** claude (implementer)
- **Why this doc exists:** The current behavior is slow on large prompts. The
  obvious fix (paste atomically) risks re-introducing the exact reliability
  problem the slow path was added to work around. We do NOT want another
  fragile fix. Codex must confirm its own input/paste behavior first.

---

## Finding

The big inter-agent handoff prompt is delivered to the codex TUI **one
character at a time with a 5 ms sleep between every char**, then submitted.
This is a deliberate throttle, not PTY streaming behavior.

`packages/cli/src/runtime/provider-submit-strategy.ts:11-21`
```ts
if (input.target === "codex") {
    // Codex has been the least reliable when large chunks are pasted at once.
    // Type the request as a short keystream, then submit on a separate beat.
    for (const char of input.text) {
        input.writeUserInput(char);   // one pty.write per char
        await sleep(5);               // 5 ms between every char
    }
    await sleep(100);
    input.writeUserInput("\r");
    return;
}
// claude branch writes the whole string in one pty.write:
input.writeUserInput(input.text);
await sleep(75);
input.writeUserInput("\r");
```

### It is not a PTY-layer streaming limit

`writeUserInput` is a direct single `pty.write(data)`
(`packages/adapter-codex/src/create-codex-live-session.ts:134-136`). The
ai-whisper layer **can** call `pty.write()` with the whole string in one shot;
the current throttling is an ai-whisper strategy choice, not a forced
limitation of `writeUserInput`. (Note: `pty.write(data)` here returns `void` —
there is no JS-level backpressure signal in this code, so do not justify the
drip as backpressure handling; it isn't.)

### Call path (confirms the big prompt takes this path)

1. `acceptPendingHandoff()` →
   `await input.submitUserInput(handoff.requestText)`
   (`packages/cli/src/runtime/mounted-turn-owned-relay.ts:453-454`)
2. In the mount, `submitUserInput` is wired to the throttled strategy:
   `submitUserInput: submitInjectedInput`
   (`packages/cli/src/runtime/mount-session-main.ts:341`) →
   `submitInjectedProviderInput({ target: "codex", ... })`
   (`mount-session-main.ts:230`)
3. → the char-by-char loop above.

So the **entire** request body (workflow handoff prompts are multi-KB) is
dripped char-by-char.

### Cost

Wall-clock to inject ≈ `len × 5 ms + 100 ms`.

| prompt size | injection delay before submit |
|-------------|-------------------------------|
| 2,000 chars | ~10 s |
| 6,000 chars | ~30 s |
| 10,000 chars | ~50 s |

Linear in prompt length. This matches the observed sluggishness during the
flow with large prompts.

---

## Why the slow path exists (do not naively remove)

The inline comment: *"Codex has been the least reliable when large chunks are
pasted at once."* The drip was a reliability workaround — a large atomic write
into the codex TUI was dropping/garbling input or mis-submitting. The throttle
traded latency for delivery integrity.

The skipped Mode B test (`test/provider-submit-strategy.test.ts`, TODO
2026-05-29) is a **placeholder/speculative RED guard, not a real bracketed-paste
reproduction**: its *comments* mention bracketed paste, but the test body does
NOT assert the `\x1b[200~ … \x1b[201~` framing — it only asserts that the tail
is not a bare `\r`. Treat it as a hint, not a verified contract. Earlier in
this investigation an unproven hypothesis (codex never executed the review;
bare `\r` absorbed by multi-line mode) was rejected by codex's own evidence —
which is exactly why we are not guessing again here.

---

## Proposed direction (UNCONFIRMED — for codex to validate or reject)

Replace the char-by-char drip with **bracketed paste**: write the payload
wrapped in `\x1b[200~ … \x1b[201~` in a single `pty.write`, then submit on a
separate beat. Goal: atomic + reliable delivery without the linear latency.

This is a hypothesis. It is plausibly the right shape but must not ship on
plausibility alone.

**Partial evidence (codex review, 2026-05-30):** the installed codex binary
*does* contain bracketed-paste markers (`[?2004h`, `[?2004l`, `paste_burst`
strings), so codex almost certainly enables bracketed-paste mode. But binary
strings do NOT prove the exact submit behavior needed for multi-line handoff
delivery — whether newlines inside a paste stay literal, and what key actually
submits afterward. Those remain unconfirmed and require live validation.

---

## What we need codex to confirm (about itself)

Answer from codex CLI's actual TUI input handling, not assumption:

1. **Bracketed paste support.** Does the codex TUI enable bracketed-paste mode
   (DECSET 2004)? When it receives `\x1b[200~ <text> \x1b[201~`, does it ingest
   `<text>` as a single atomic pasted block into the composer?
2. **Newlines inside a paste.** Are `\n` / `\r` *inside* a bracketed paste
   treated as literal newlines in the composer (NOT premature submit)? This is
   the crux for multi-line prompts.
3. **Submit semantics.** After a bracketed paste lands in the composer, what
   actually submits it? A trailing `\r` on a separate beat? `\n`? Something
   else? Does the paste itself ever auto-submit?
4. **Original failure mode.** What specifically broke when large chunks were
   written at once (the reason the drip exists)? Dropped bytes? TUI render race?
   A newline in the payload triggering early submit? Knowing this tells us
   whether bracketed paste actually addresses the root cause.
5. **Size limits.** Is there a max paste/input size codex ingests reliably in
   one shot, or a chunk threshold we should respect?
6. **Multi-line submit key.** In multi-line composer mode, what is the correct
   submit key vs newline-insert key (Enter vs Ctrl+J, etc.)? The Mode B test had
   conflicting evidence on this.

### Acceptance for proceeding

We proceed with the bracketed-paste fix only when codex confirms (1)–(3)
concretely and (4) shows bracketed paste addresses the original failure mode.
If any answer is "no" / "unknown," we redesign — no fragile fix.

---

## Files referenced

- `packages/cli/src/runtime/provider-submit-strategy.ts` (the throttle)
- `packages/cli/src/runtime/mounted-turn-owned-relay.ts` (accept handoff path)
- `packages/cli/src/runtime/mount-session-main.ts` (wires submitUserInput)
- `packages/adapter-codex/src/create-codex-live-session.ts` (writeUserInput → pty.write)
- `test/provider-submit-strategy.test.ts` (skipped Mode B RED test)
