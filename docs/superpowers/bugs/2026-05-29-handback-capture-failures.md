# Bug: workflows halt with "No handbackText provided" — handback capture fails in two distinct modes

**Filed:** 2026-05-29
**Affected versions:** observed on 0.3.0 (2026-05-28) and 0.4.0 (2026-05-28). State.db evidence shows capture-failure rate jumped from 0% to ~7.5% on 2026-05-28.
**Affected components:**
- `packages/cli/src/runtime/mounted-turn-owned-relay.ts` (classifier + auto-handback driver)
- `packages/cli/src/runtime/capture-handback-text.ts` (lease-wrapped capture)
- `packages/cli/src/runtime/clipboard-handback-capture.ts` (poll/`/copy` injection)
- `packages/cli/src/runtime/provider-submit-strategy.ts` (codex per-char typing path)
- `packages/cli/src/runtime/assistant-turn-capture.ts` (PTY turn buffer)

## Symptom

The orchestrator halts autonomous workflows with `halt_reason` like:

> No handbackText provided — executor did not deliver verification output, commit SHAs, or summary. The executor appears to be blocked or unable to respond at all, preventing assessment of work completion.

Operator perception is "this halts more often on the newest version." DB evidence confirms a real spike on 2026-05-28.

## Evidence (from `~/.ai-whisper/state.db`)

### Capture failure rate per day

| Date | ok | fail | fail% |
|------|----|------|-------|
| 2026-05-21 | 14 | 0 | 0% |
| 2026-05-22 | 29 | 1 | 3.2% |
| 2026-05-23 | 48 | 2 | 3.9% |
| 2026-05-24 | 52 | 2 | 3.6% |
| 2026-05-25 | 30 | 0 | 0% |
| 2026-05-26 | 31 | 0 | 0% |
| 2026-05-27 | 22 | 0 | 0% |
| **2026-05-28** | **62** | **5** | **7.4%** |
| **2026-05-29** | **11** | **1** | **7.7%** |

Failures correlate with the v0.3.0 (pause/resume) and v0.4.0 (dashboard) ships on 2026-05-28.

### Halts produced

Of the 6 capture failures on 2026-05-28/29, **1** converted into a workflow halt — `wf_3ce9d0da4ce54e06` at 2026-05-29 02:51Z. The others were absorbed as a single retry in their chain.

### The 5 capture-failure rows (May 28–29)

Source: `relay_capture_diagnostics` joined to `relay_handoff`.

| handoff_id | target | clip_len | turn_len | turn_conf | created_at | collab |
|---|---|---|---|---|---|---|
| `ho_6ce38ae6cdbf482d` | claude | 48 | 0 | low | 2026-05-29 02:43:26Z | (halted wf) |
| `ho_5200aaa55dd14a1e` | claude | 0 | 0 | low | 2026-05-28 10:27:15Z | |
| `ho_815a765062fd467c` | claude | 42 | 0 | low | 2026-05-28 10:17:32Z | `…ac563a21` |
| `ho_ac1de5dd20a74558` | codex | **0** | **174561** | high | 2026-05-28 06:13:05Z | `…ac563a21` |
| `ho_beaae6f04ddd4c1d` | codex | **0** | **155267** | high | 2026-05-28 06:13:30Z | `…931f8d0a` |
| `ho_59e11a13bd86449a` | claude | 0 | 0 | low | 2026-05-28 05:08:29Z | |

Two clearly distinct modes. The codex-target failures happened in **two different collabs at the same wall-clock minute** — operator confirms they were running concurrent collabs across projects.

---

## Mode A — claude target, short reply rejected as low-confidence

### Prior context (important)

This is a **known issue with a deferred fix**. See memory `mem-2026-05-20-classifycapture-discards-terse-but-d6b864` and design doc `docs/superpowers/specs/2026-05-14-capture-reliability-hardening-design.md`.

Prior decision (2026-05-19, "Option A"): worked around by mandating that every autonomous-handback prompt force the agent to lead with verdict + 1–2 sentence justification, > 100 chars, never a single word. The intent was for replies to always clear the `clipText.trim().length >= 100` fast-path in `classifyCapture`.

Prior decision (deferred, "Option B"): properly fix `classifyCapture` so a freshly-changed short clipboard is trusted on its own merits (punctuation-aware tokenization + trust fresh `/copy` that differs from the injected prompt). Design doc above lays out the full hardening plan in three phases.

**This bug demonstrates Option A has slipped.** The May 28–29 failures show claude producing replies under 100 chars regardless of the prompt-layer instruction. The fix path is now to either (a) re-tighten Option A in whichever templates regressed, or (b) finally land Option B from the design doc. Recommend (b) — band-aiding prompts further is explicitly called out in the memory as the wrong move.

### Pattern

`clip_len` ∈ [42, 85] (an actual short reply), `turn_len = 0`, `turn_confidence = low`.

Sample `clip_sample` values:
- `"Task 1 verifies clean. Commit and move on."`
- `"Not relevant — same merge-at-finish-time memory."`

These are **real, complete claude replies**, not stale-clipboard junk. But the classifier rejects them.

### Root cause hypothesis

`classifyCapture` in `mounted-turn-owned-relay.ts:168-209`:

- `clipText.trim().length >= 100` → trust as ok (the documented full-screen-TUI bypass).
- `clipText` non-empty but **< 100** → require `turnResult.confidence === "high"` and jaccard/containment similarity ≥ 0.6/0.8.
- Otherwise → `no_response_captured_confidently`.

For Claude Code (full-screen TUI), `normalizeCapturedOutput` in `assistant-turn-capture.ts` strips CSI escapes and applies bare-`\r` overwrite. Cursor-positioned full-screen output frequently normalizes to **empty or junk**, so `turnResult.text` ends up empty, `extractLatestAssistantTurn` returns `{ confidence: "low", text: null }`, and the short-clip branch's similarity check cannot execute.

**Net effect:** any valid claude reply under 100 chars halts the workflow even though the clipboard genuinely captured the right text. The classifier has a bypass for "trust large clipboards from TUI providers" but no analogous bypass for "short but freshly-changed clipboard from TUI providers" — and `captureClipboardHandback` already guarantees freshness (it returns only on a clipboard change after `/copy`).

### Suggested investigation / fix direction

Primary path: **execute Option B per `docs/superpowers/specs/2026-05-14-capture-reliability-hardening-design.md`** (phases already defined; Phase 1 — diagnostics — already shipped, hence this report's evidence). The two remaining phases address exactly the freshness-trust-and-tokenization gap. Preserve stale-clipboard protection that the ≥100-char / similarity gate provides; the fix is to extend the trust criteria, not remove the gate.

Secondary / interim:

- Find where claude's "Task 1 verifies clean. Commit and move on." replies originated and whether the prompt template for that handoff stripped the > 100-char wrapper from the Option A workaround. If so, restore it as an interim guard.
- Confirm `recordProviderOutput` is receiving Claude's PTY stream for these handoffs (it should be — `mount-session-main.ts:237-240` hooks it) and that `normalizeCapturedOutput` strips it to empty/junk. A debug dump of `current` at the moment `finishAssistantTurn` is called would prove this.
- Alternative high-confidence-turn source: read the on-screen viewport via `tmux capture-pane` on the pane the session owns, instead of reconstructing from the raw PTY stream.

---

## Mode B — codex target, prompt sits in input box, never executes

### Pattern

`clip_len = 0`, `turn_len ≈ 150–175k`, `turn_confidence = high`. Both observed failures during concurrent-collab activity.

`turn_sample` (truncated 200-char head) for both shows the typed prompt visible inside codex's input box (note the missing spaces — TUI rendering artifact in the normalized PTY stream), followed by codex's **idle input-footer legend** "Create a plan? · shift + tab use Plan mode · esc".

That legend is NOT Plan Mode UI; it is the standard footer codex shows while the input box is idle and waiting for the user to hit Enter. So the prompt was **typed but never submitted**.

### Reproduction context

- Operator was running 2+ collabs (multiple workflows across projects) concurrently when both failures occurred.
- Both failing handoffs are `claude → codex`, both targeting codex, both with 3.8–4.1k-char prompts containing 37 embedded LF chars.
- Surrounding handoffs in the same collab (`…ac563a21`) with identical prompt template and same LF-count succeed. So it's not a content-shape issue — it's timing.

### Root cause hypothesis

`packages/cli/src/runtime/provider-submit-strategy.ts:11-20` types codex prompts char-by-char with a 5 ms gap, then `sleep(100)`, then writes `\r`:

```ts
if (input.target === "codex") {
    for (const char of input.text) {
        input.writeUserInput(char);
        await sleep(5);
    }
    await sleep(100);
    input.writeUserInput("\r");
}
```

For a 3.8k-char prompt this is ~19 s of typing. Under concurrent-collab CPU contention, two failure scenarios are plausible:

1. **Multi-line mode + lost submit.** The prompt contains 37 embedded LFs. As each LF is typed at 5 ms cadence, codex auto-enters multi-line mode (each LF inserts a newline in the input). In multi-line mode plain Enter inserts another newline; submission requires Esc-Enter / Ctrl+J. The trailing `\r` therefore just appends a blank line — the prompt sits in the box forever and no assistant message is ever produced. `/copy` then copies the previous (possibly empty) assistant message, yielding `clip_len = 0`.

2. **Idle-trigger early submission.** Under CPU contention, the per-char `await sleep(5)` extends to tens of ms, giving codex enough idle to auto-submit a partial prompt (if codex has any idle-auto-submit). Remaining characters then type into a fresh input box and the final `\r` submits an incomplete fragment. The first (partial) execution produces some assistant output, but the auto-handback's `/copy` may run against a state where the most recent visible turn is the fragment, not the operator-intended response. (Less likely than #1, but worth ruling out.)

3. **Concurrent-collab event-loop starvation.** Two mounted Node processes both running `submitInjectedProviderInput` at the same wall-clock minute means the OS pageins/disk I/O for both share the same host. The 100 ms `sleep` before `\r` could land while codex is mid-redraw and miss the input window. Pure speculation without an instrumented repro.

Hypothesis #1 is the strongest match to the observed evidence (large turn buffer = lots of input-box redraws during typing; empty clipboard = no assistant message; only fails under contention because that's when typing cadence slips enough for codex to commit to multi-line mode mid-stream).

### Suggested investigation / fix direction

- Add `AI_WHISPER_DEBUG_INPUT_LOG` to a repro session and capture the `programmatic-submit` byte-stream for both successful and failing codex handoffs. Confirm whether codex sees the trailing `\r` and how it interprets it.
- Convert the codex submit path from "type then Enter" to **bracketed paste** (`\e[200~` … `\e[201~`) followed by Esc-Enter or Ctrl+J. Bracketed paste preserves the entire prompt as a single atomic insert (codex's TUI handles it correctly today for human paste) and avoids per-char timing dependence on host load.
- If multi-line mode is the culprit, an alternative is `\eOM` or Ctrl+J after the typing window instead of `\r`.
- Instrument `clipboard_capture_lease` writes with holder collab + acquire-wait-ms so we can confirm whether concurrent collabs are contending on the lease at the moment of failure.

---

## Reproduction plan

### Mode B (codex target)

1. Set up two collabs in two different project directories.
2. In each, start an autonomous workflow that produces a `claude → codex` handoff with a prompt of ≥ 3000 chars containing ≥ 20 embedded LF chars (the SDD `Review the implementer's changes for this phase…` template qualifies).
3. Time the two workflow `whisper workflow start` calls to land within ~30 s of each other so both reach the codex submit window concurrently.
4. Watch each codex pane: a failed submission leaves the prompt visible in codex's input box (no assistant response). Confirm via `sqlite3 ~/.ai-whisper/state.db "SELECT handoff_id, capture_status, clip_len, turn_len FROM relay_capture_diagnostics ORDER BY created_at DESC LIMIT 5;"`.

Repro success: at least one row with `clip_len=0`, `turn_len > 100000`, `target_provider=codex`.

### Mode A (claude target)

1. Arrange a chain where the autonomous orchestrator asks claude something whose correct reply is under 100 chars (e.g., a one-liner verdict).
2. Let auto-handback fire.
3. Confirm the row shows `target_provider=claude`, `clip_len ∈ (0,100)`, `turn_len=0`, `capture_status=no_response_captured_confidently`, and the workflow halts on that single handoff.

Repro success: orchestrator's halt reason quotes "No handbackText provided" even though the clip_sample contains the real (short) reply.

## Acceptance criteria

A fix is accepted when, with the repro setups above:

- Mode A: a short, valid claude reply (≥ 1 char, freshly captured) is accepted as `ok` and forwarded as the handback text. No halt.
- Mode B: a 4k-char codex prompt submits and executes reliably even with 2 concurrent collabs running similar prompts. The codex pane reaches an assistant turn; `/copy` returns the assistant message; `clip_len > 0`; workflow advances.

Both modes must be covered by new tests:
- Mode A: a unit test in `test/mounted-turn-owned-relay.test.ts` (or sibling) that exercises `classifyCapture` with `clipText="ok reply"`, `turnText=""`, `turnConfidence="low"` and asserts `status === "ok"` under the new rule.
- Mode B: an integration test that drives `submitInjectedProviderInput({target:"codex", text})` with a 3k-char + embedded-newlines payload against a recording sink, asserting that the payload arrives intact and is followed by an explicit submit byte sequence that codex interprets as "submit", regardless of per-char timing jitter.

## Non-goals

- Do not change the orchestrator's halt-on-empty-handback policy. The bug is upstream; the orchestrator is correctly escalating a genuinely empty handback.
- Do not change the lease TTL or acquire-timeout defaults. The lease appears to be operating correctly; concurrency is a load symptom, not the cause.
