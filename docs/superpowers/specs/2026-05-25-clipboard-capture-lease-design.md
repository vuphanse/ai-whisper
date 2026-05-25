# Clipboard Capture Lease — Design Spec

**Date:** 2026-05-25
**Branch:** spec/clipboard-capture-lease
**Status:** Draft for review

## Problem

The relay captures an agent's handback text by injecting `/copy` into the agent's
PTY and reading the result back from the **macOS system clipboard** (`pbpaste`)
in `captureClipboardHandback` (`packages/cli/src/runtime/clipboard-handback-capture.ts`).

The system clipboard is a single global resource per login session. Multiple
collabs run autonomous workflows on one host concurrently, and a human may copy
at any time. The current freshness check only proves the clipboard *changed*,
not that it changed to *this* collab's text. Concretely:

- Collab A injects `/copy`, then before A reads, Collab B injects `/copy` →
  A reads B's text.
- A human presses ⌘C mid-window → A reads the human's text.

This is worsened by the ≥100-char fast-path in `classifyCapture`
(`packages/cli/src/runtime/mounted-turn-owned-relay.ts:176`, memory
`mem-2026-05-20-classifycapture…`): a clipboard payload **≥100 chars is
trusted as `ok` with no similarity check** against this collab's PTY turn text.
Most real responses exceed 100 chars, so **under contention** a collab blindly
trusts another collab's response as its own and delivers it into the wrong
workflow.

Note the fast-path is **not** a defect to remove: it is the deliberate Option-A
workaround (shipped 2026-05-19) for workflow-review steps where the PTY turn is
dominated by the *echoed prompt*, so even a correct response scores near-zero
similarity. Forcing similarity on ≥100-char captures would regress that case.
The fast-path is only dangerous **because of the race**; eliminating the race
makes it safe again — so this design fixes the race, not the fast-path.

## Why not avoid the system clipboard entirely?

Empirically verified (2026-05-25, tmux `set-clipboard off`, both CLIs):

| CLI | OSC 52 emitted? | Writes system clipboard directly? | File dump? |
|-----|:---:|:---:|---|
| Claude Code 2.1.150 | yes | yes | `/tmp/claude-<uid>/response.md` |
| codex 0.133.0 | **no** | yes | no |

A single `/copy` advances `NSPasteboard.changeCount` by exactly **+1** on both
providers (measured 2026-05-25). This is the anchor for the ownership check
below: after one `/copy`, any delta > 1 means a *foreign* write interleaved.

Both CLIs write the macOS pasteboard **directly** (native, bypassing the
terminal) — the clipboard changed even with tmux clipboard forwarding off.
codex emits **no OSC 52 and no file**; its only output channel is the direct
pasteboard write. Claude Code's extra channels (OSC 52, `response.md`) cannot
help: OSC-52 interception works only for Claude, and `response.md` is a single
shared file per uid (same race, different medium).

**Conclusion:** the system clipboard is the only common channel across both
providers, so the fix must make that shared resource *safe*, not avoid it.

Attribution-by-pid is also off the table: macOS exposes no public
"pasteboard writer pid" API, codex writes via native `NSPasteboard` (no
`pbcopy` binary to trace), and attribution would only *detect* a collision
after the clobber, not prevent it.

## Solution: a host-global capture lease (serialized injection queue)

We control when each `/copy` is injected and when the result is read. If only
one `/copy`→read window is ever outstanding host-wide, then "we triggered it"
**does** equal "the clipboard value is ours." This is a cross-process queue:
the next `/copy` is not injected until the previous capture has been read.

It must be cross-process because capture runs inside separate mount-session
processes (and there are multiple per-workspace broker daemons). Every process
on the host already opens one **shared SQLite DB** (`getSharedSqlitePath()`),
and host-global atomic coordination already lives there (one-active-collab via a
conditional unique index, `enforce-one-active-collab.ts`). The lease reuses that
substrate.

### Components

1. **`clipboard_capture_lease` table** (new, shared DB) — at most one row.
   Columns: `id` (constant singleton key), `holder_collab_id`, `holder_pid`,
   `acquired_at`. Atomic acquire/release via short `db.transaction()` calls,
   matching the idioms in `enforce-one-active-collab.ts`.

2. **`acquireCaptureLease` / `releaseCaptureLease`** — acquire succeeds if the
   lease is free **or** stale (holder pid dead via `process.kill(pid,0)`, or
   `acquired_at` older than TTL). The lease is **logical**: a short txn marks
   ownership, the holder does its async `/copy`+poll *outside* any open
   transaction, then a second short txn releases. We never hold a SQLite write
   transaction open across the async capture window (that would block all
   host-wide DB writes, including the broker).

3. **Capture wrapped by the lease** — in the `captureHandbackText` path
   (`mount-session-main.ts:360`), acquire the lease, run the existing
   `captureClipboardHandback`, release in a `finally`. Waiters poll-acquire with
   backoff until free.

4. **Captured text flows into the existing handback/handoff row** — no new
   evidence artifact. The handoff row is already `{collabId, handoffId}`-
   attributed and is already what the orchestrator/evaluator reads for the
   verdict. The lease makes the captured value trustworthy; the existing data
   path is unchanged.

5. **Leave `classifyCapture` unchanged** — the lease guarantees the read is this
   collab's own `/copy` output, so the ≥100-char fast-path is safe for the
   collab-vs-collab case without modification. Removing it would regress the
   workflow-review terse/echoed-prompt case (Option A, memory
   `mem-2026-05-20-classifycapture…`). The only payload the fast-path could still
   wrongly trust is a human ⌘C inside the held window — handled by the
   `changeCount` ownership check (component 6), **not** by forcing similarity.

6. **`changeCount` ownership check + interference resolution** (core) — the lease
   stops *collab* interference; this stops *human* interference inside the held
   window. Snapshot `NSPasteboard.changeCount` (`C0`) immediately before
   injecting `/copy`; after the capture read settles, read `Cn`. `Cn − C0 == 1`
   ⇒ only our write happened (clean, accept). `Cn − C0 > 1` ⇒ a foreign write
   interleaved → run the resolution ladder. The check is **advisory**: it must
   never hard-block a turn. See "Interference resolution" below.

### Lease cleanup (required)

- **Stale reclaim on acquire:** a free-or-stale check lets a new holder reclaim a
  lease whose `holder_pid` is dead or whose `acquired_at` exceeds the TTL
  (covers a mount that crashed mid-capture).
- **TTL:** bound the maximum hold to slightly above the worst-case capture
  window (`attempts × delayMs` + trigger delay; today ~1.3s, so a few seconds).
- **Release on disconnect:** release in the same disconnect/stop paths that
  already tear down a mount (mirroring dead-daemon handling).
- **Startup sweep:** clear/reclaim a stale singleton row on broker startup,
  alongside the existing `applyMigrations`/enforce pass.

### Interference resolution (the human ⌘C case) — must never block

The lease serializes everything *we* inject; it cannot serialize a human
pressing ⌘C during the (now single) capture window. The `changeCount` check
(component 6) detects this (`Cn − C0 > 1`). **Detection triggers recovery, never
a stop** — the worst outcome is a degraded capture identical to today's existing
fallback. The ladder, in order:

1. **Re-capture under the still-held lease.** We have not released the lease, so
   no *collab* can interfere; re-inject `/copy`, re-snapshot `C0`, re-read.
   Bounded to `N` attempts (default 2) with short backoff. A human is unlikely
   to collide on consecutive attempts.
2. **Content acceptance (similarity/identity only — never the fast-path).** On
   any attempt, accept the captured clipboard *only* if it actually matches this
   collab's PTY turn text by content: an exact/normalized identity match, or a
   similarity score clearing the existing `classifyCapture` thresholds
   (`jaccard ≥ 0.6` or `containment ≥ 0.8`). This check **must bypass the
   ≥100-char fast-path** — once `changeCount` has flagged interference
   (`Cn − C0 > 1`), the fast-path's "any substantial clipboard is ours"
   assumption is exactly what is no longer true, so accepting on length alone
   would re-admit the foreign ≥100-char human copy the `changeCount` check just
   detected. Matching content means it is effectively ours and is safe to accept
   regardless of `changeCount`; this also makes the check self-correcting if the
   +1 assumption is ever wrong for a future provider version. A clipboard that
   only clears the length floor but fails similarity/identity is **not** accepted
   here — it falls through to step 3.
3. **PTY-only degrade.** If every attempt shows interference *and* content never
   validates, fall back to the PTY turn text (the existing degraded path) and
   record a capture diagnostic flagged `interference_detected`. The workflow
   proceeds — never blocked, never hung.

**Native helper, with graceful degradation.** `changeCount` is exposed only via
a native call (`osascript` does not surface it), so we ship a tiny Swift/ObjC
helper binary (`swiftc`-compiled at build time, cached; runs instantly — no
per-call recompile). If the helper is **unavailable** (build failed, non-darwin,
or it errors), the `changeCount` check is **skipped** and capture proceeds on the
lease + similarity alone. The defense degrades off; it never becomes a hard
dependency that blocks capture.

## Architecture / data flow

```
mount-session (collab A)                shared SQLite DB
  capture turn:
    acquireCaptureLease(A, pid) ───────► txn: free-or-stale? set holder=A   (waiters block/backoff)
    C0 = changeCount()                  (skipped if helper unavailable)
    inject "/copy" into A's PTY
    poll pbpaste until changed (existing captureClipboardHandback)
    Cn = changeCount(); if Cn-C0 > 1 → interference ladder (re-capture → content-accept → PTY-only)
    classifyCapture(turnText, clip)
    requestText → existing handback/handoff row  (verdict evidence, unchanged)
    releaseCaptureLease(A) ─────────────► txn: clear holder
```

Only one collab holds the lease at a time, so the `pbpaste` read is provably the
result of *this* collab's `/copy`.

## Components & boundaries

- **`clipboard-capture-lease.ts` (broker storage)** — pure DB acquire/release/
  reclaim functions + table DDL. Depends on: `better-sqlite3`, a `pid`-liveness
  injectable (test seam, mirrors `EnforceOptions.isPidAlive`). No PTY/clipboard
  knowledge.
- **`captureHandbackText` wrapper (cli runtime)** — orchestrates
  acquire → `changeCount(C0)` → `captureClipboardHandback` → `changeCount(Cn)` →
  interference ladder → release. Depends on the lease module, the existing
  capture function, and the changeCount reader. No DB schema knowledge beyond the
  lease API.
- **`changeCount` reader (native helper + JS wrapper)** — `swiftc`-built binary
  compiled at package build, cached; JS wrapper returns the count or `null` when
  the helper is missing/errors (caller then skips the check). No clipboard
  *content* access — count only.
- **`classifyCapture`** — unchanged. The lease removes the race that made its
  ≥100-char fast-path unsafe; the fast-path stays (it is load-bearing for
  workflow-review terse verdicts).

## Error handling

- Acquire never blocks indefinitely: bounded poll-acquire with backoff and a
  max-wait; on timeout, fall back to PTY-only capture (degraded but safe) and
  record a diagnostic.
- Release always runs in `finally`; a crashed holder is reclaimed via stale TTL.
- Lease table errors are non-fatal to the relay where possible, but a failed
  acquire must **not** silently proceed to a racy read — it degrades to PTY-only.
- `changeCount` helper missing/errors → skip the check (lease + similarity still
  apply); never block on it.
- Interference detected → resolution ladder (re-capture → content-accept →
  PTY-only); never block, never hang.

## Testing

- **Lease unit:** acquire when free; block when held; reclaim when holder pid
  dead; reclaim when TTL exceeded; release clears holder. Inject `isPidAlive`
  and a clock for determinism (mirror `enforce-one-active-collab` tests).
- **Serialization:** two simulated collabs contending → second acquires only
  after first releases; captured texts never cross.
- **Fast-path preserved under lease:** a foreign ≥100-char clipboard never
  reaches the read window because the lease serializes injection; the ≥100-char
  fast-path itself is unchanged (regression guard for terse workflow-review
  verdicts).
- **Degrade path:** acquire timeout → PTY-only capture + diagnostic, no wrong
  text delivered.
- **changeCount ladder:** `Cn − C0 > 1` → re-capture; re-capture that validates
  by content (similarity/identity match to the PTY turn text) → accepted;
  persistent interference + invalid content → PTY-only + `interference_detected`
  diagnostic. Assert the turn is never blocked.
- **changeCount ladder rejects foreign long copy (regression guard):** with
  interference detected (`Cn − C0 > 1`) and a captured clipboard that is ≥100
  chars but does **not** match the PTY turn text by similarity/identity, the
  content-acceptance step must **reject** it (the ≥100-char fast-path is bypassed
  in the interference path) and fall through to PTY-only +
  `interference_detected`. This is the human-⌘C guarantee: a foreign long copy
  inside the held window is never accepted as this collab's answer.
- **changeCount helper absent:** check skipped, capture still succeeds on lease +
  similarity. Inject a `null`-returning reader to simulate.
- **Cleanup:** startup sweep reclaims a stale singleton row left by a dead pid.

## Edge cases

- Mount crashes holding the lease → reclaimed by next acquirer (dead pid / TTL).
- Two collabs acquire in the same instant → SQLite write serialization picks one;
  the other sees held and backs off.
- Clock skew / system sleep inflating `acquired_at` age → TTL reclaim may fire
  early; acceptable (worst case: a redundant re-capture).
- Human ⌘C during a held window → `changeCount` delta > 1 triggers the
  resolution ladder (re-capture, then content-accept, then PTY-only); the turn
  still completes.
- Human ⌘C *and* changeCount helper unavailable → falls back to the similarity
  check alone (rejects unrelated <100-char content); a ≥100-char human copy is
  the one uncovered case in this degraded mode — acceptable and rare.
- Capture genuinely produced nothing (no clipboard change) → existing
  `no_response_captured*` statuses still apply; lease released normally.

## Out of scope

- OSC-52 / per-pane interception (provider-specific, codex unsupported).
- A separate per-collab capture artifact (existing handback/handoff row is the
  verdict evidence).
- Modifying `classifyCapture`'s ≥100-char fast-path (load-bearing for
  workflow-review terse verdicts; the lease removes the need — Option A,
  `mem-2026-05-20-classifycapture…`).
