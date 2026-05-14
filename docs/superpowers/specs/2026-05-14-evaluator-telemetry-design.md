# Evaluator Telemetry Design

**Date:** 2026-05-14
**Branch:** spec/evaluator-telemetry

## Relationship to Prior Specs

Extends:

- [`2026-04-09-relay-orchestrator-agent-design.md`](2026-04-09-relay-orchestrator-agent-design.md) — defines the orchestrator + evaluator contract this spec instruments.
- [`2026-05-14-capture-reliability-hardening-design.md`](2026-05-14-capture-reliability-hardening-design.md) — Phase 1 introduced `relay_capture_diagnostics`, the diagnostics-sweep timer, and the `whisper collab inspect --captures` surface. This spec mirrors those patterns for the LLM evaluator layer.

Does **not** change:

- The orchestrator's verdict vocabulary (`done` / `loop` / `escalate`, plus workflow verdicts `approve` / `findings` / `delivered` / `execution-pass` / `execution-fail` / `escalate`).
- Evaluator prompts, JSON schemas, or zod parsers.
- Provider fallback policy (primary → fallback on `ECONNREFUSED` / `ETIMEDOUT` / `429` / `5xx`; validation errors do not trigger fallback).
- The orchestrator's `try/catch` around the evaluator call.

## Problem

Phase 1 made the *input* to the orchestrator's LLM call visible (`relay_capture_diagnostics`: what we captured from the provider's PTY/clipboard). What happens inside the LLM call itself is still a black box:

- Which prompt branch ran (`legacy` / `review` / `delivered` / `execution`)?
- Did the JSON response parse, or did we hit a zod validation error?
- Did the primary provider answer, or did fallback fire — and if so, with what failure on the primary?
- How long did each call take? How many tokens did Anthropic charge us?
- For `loop` / `findings` verdicts, was a follow-up message produced?

Today the only way to investigate an escalated chain is to re-run it or hope someone captured stderr. Each replay costs real LLM tokens and a manual triage session.

End-state with both telemetry layers, looking at an escalated chain:

1. **Capture:** "we captured 87 chars, jaccard 0.3 — `no_response_captured_confidently`"
2. **Evaluator:** "given that, anthropic was unavailable (ECONNREFUSED, 5012 ms), fell back to ollama which returned `escalate` with confidence 0.4 in 2140 ms, reason 'output unclear'"

Today only #1 is visible.

## Scope

In scope:

- New `relay_evaluator_diagnostics` SQLite table + indexes (sidecar pattern, matching Phase 1).
- Repository + broker control method, following the Phase-1 capture pattern.
- An `onCall` observer hook on `createRelayOrchestratorEvaluator` that fires once **per LLM call** — twice on fallback. The verdict return semantics (`Promise<EvaluatorAnyVerdict>` with the same throw behavior) are unchanged; the internal call signature changes from `(payload)` to `(call: EvaluatorCall)` so observer-only context (handoff/collab/chain/workflow/phase IDs) can be threaded without leaking into the LLM prompt. The single wiring site is `packages/cli/src/bin/broker-daemon.ts`.
- One diagnostic row per LLM call (so two rows on fallback, linked via shared `call_group_id`).
- Token columns (`input_tokens`, `output_tokens`) populated by Anthropic via `response.usage`; NULL for Ollama.
- The broker-daemon `onCall` callback writes the row inside `try/catch` so SQLite failures cannot stall the relay.
- `whisper collab inspect --verdicts [chainId|all] [--watch]` CLI surface, mutually exclusive with `--captures`.
- Retention via the existing `diagnostics-sweep` timer — one extra DELETE statement, no new timer or env var.
- Privacy gate: `AI_WHISPER_NO_EVAL_SAMPLES=1` writes NULL into `prompt_sample` / `response_sample` while still recording length / score / verdict / latency / token counts.

Out of scope (deferred):

- **Streaming evaluator calls.** Evaluator calls are not streamed today; if we ever change that, latency semantics shift and we revisit.
- **Cost rollup queries.** Per-chain or per-day cost aggregation is downstream of having the token data. Schema supports it; UI/CLI for it can come later.
- **Replay-from-diagnostic.** A `whisper collab eval-replay <evaluator_id>` command that re-issues the captured prompt and diffs the verdict would be powerful but is its own feature.

## Architecture

A new SQLite table `relay_evaluator_diagnostics` holds one row per LLM call. The evaluator factory in `packages/cli/src/runtime/relay-orchestrator-evaluator.ts` gains an optional `onCall(event)` observer that fires once per provider call, carrying branch / provider / attempt-kind / outcome / latency / token usage / raw response / error / verdict.

The evaluator is **constructed in exactly one place** — `packages/cli/src/bin/broker-daemon.ts:53` — and passed into `createRelayOrchestrator` as the `evaluate` parameter. The orchestrator (`packages/cli/src/runtime/relay-orchestrator.ts`) is the single consumer; it handles both the legacy (chain-loop) and workflow (review-loop / execution-gate) branches internally. `workflow-driver.ts` does **not** call the evaluator — it only manages phase lifecycle and reacts to orchestrator-applied verdicts.

This means there is **one wiring point**: the `broker-daemon.ts` construction site passes an `onCall` callback to `createRelayOrchestratorEvaluator`. The callback writes the diagnostic row via `broker.control.recordEvaluatorDiagnostic(...)` inside try/catch. No "drift between two wirings" risk — there is only one.

The orchestrator's role is to thread handoff context (`handoffId`, `collabId`, `chainId`, `workflowId`, `phaseRunId`) to the observer. This context **must not** be added to the existing `EvaluatorInput` / `WorkflowEvaluatorInput` types: the provider callers do `JSON.stringify(payload)` as the user message to the LLM, so any fields on the payload type leak into the prompt. The orchestrator's existing `input.evaluate(payload)` call shape changes to `input.evaluate({ payload, context })` where `context: ObserverContext` is consumed only by `onCall` and never serialized to the LLM. See "Observer hook" below for the type definitions.

Retention reuses the `createDiagnosticsSweep` module from Phase 1 — one more SQL DELETE keyed on `created_at < ?`. No new timer, no new env var. The module was named `diagnostics-sweep` (not `capture-diagnostics-sweep`) specifically so this kind of additive work composes.

## Schema — `relay_evaluator_diagnostics`

24 columns. One row per LLM call.

| Column | Type | Notes |
|---|---|---|
| `evaluator_id` | TEXT PRIMARY KEY | `eval_<digits-only-iso>_<random8>` — random8 is `crypto.randomUUID().slice(0,8)`. The timestamp prefix gives log-grep readability; the random suffix guarantees uniqueness even when the same handoff fires multiple LLM calls within a millisecond (orchestrator retry × primary/fallback × fast tests). |
| `handoff_id` | TEXT NOT NULL | FK shape only; same as `relay_capture_diagnostics.handoff_id`. Indexed. |
| `collab_id` | TEXT NOT NULL | Indexed. Always populated. |
| `chain_id` | TEXT | Nullable. Indexed. |
| `workflow_id` | TEXT | Nullable. Set when the evaluator was invoked for a workflow step. |
| `phase_run_id` | TEXT | Nullable. Set when the evaluator was invoked for a workflow step. |
| `evaluator_branch` | TEXT NOT NULL | `"legacy"` / `"review"` / `"delivered"` / `"execution"`. |
| `evaluator_prompt_key` | TEXT | Nullable. Workflow-only: `"review-loop"` or `"execution-gate"`. |
| `handoff_step` | TEXT | Nullable. Workflow-only: `"review"` / `"fix"` / `"implement"` / `"execute"`. |
| `attempt_kind` | TEXT NOT NULL | `"primary"` or `"fallback"`. One row per LLM call, so a fallback event produces a `primary` row (with the primary's failure outcome) AND a `fallback` row (with the fallback's outcome). |
| `call_group_id` | TEXT NOT NULL | UUID generated by the evaluator factory at the start of each invocation. Both the primary row and the fallback row (if fired) share the same `call_group_id`. **Replaces the prior `parent_evaluator_id` design** — carrying the group id through the observer event itself is robust against insert failures on the primary row, whereas a "look up most recent primary" query is not. Indexed. |
| `provider` | TEXT NOT NULL | `"anthropic"` or `"ollama"` — the provider that was called for THIS row. |
| `outcome` | TEXT NOT NULL | `"ok"` / `"parse_error"` / `"validation_error"` / `"provider_unavailable"` / `"unknown_error"`. |
| `verdict` | TEXT | Nullable. The parsed verdict string (`"done"`, `"approve"`, `"execution-fail"`, etc). NULL when `outcome != "ok"`. |
| `confidence` | REAL | Nullable. NULL when verdict is NULL. |
| `reason` | TEXT | Nullable. NULL when verdict is NULL. |
| `follow_up_message_len` | INTEGER | Nullable. Length of `followUpMessage` for `loop` / `findings` verdicts; 0 for verdicts without it; NULL when verdict is NULL. |
| `latency_ms` | INTEGER NOT NULL | Wall-clock measured inside the evaluator factory around this single provider call (immediately before the underlying Anthropic/Ollama call, again when it resolves or throws). Not measured at the orchestrator boundary — that would include parse + zod validation overhead. |
| `error_message` | TEXT | Nullable. The error's `.message` when `outcome != "ok"`. Truncated to 500 chars. |
| `input_tokens` | INTEGER | Nullable. Anthropic populates from `response.usage.input_tokens`; Ollama leaves NULL. |
| `output_tokens` | INTEGER | Nullable. Anthropic populates from `response.usage.output_tokens`; Ollama leaves NULL. |
| `prompt_sample` | TEXT | Nullable. First 500 chars of `systemPrompt + "\n---\n" + JSON.stringify(payload)`. NULL when `AI_WHISPER_NO_EVAL_SAMPLES=1`. |
| `response_sample` | TEXT | Nullable. First 500 chars of the raw LLM response. NULL when `outcome != "ok"` and no response arrived, or when `AI_WHISPER_NO_EVAL_SAMPLES=1`. |
| `created_at` | TEXT NOT NULL | ISO-8601 timestamp. |

Indexes:

- `(collab_id, created_at DESC)` — drives the default inspect view.
- `(handoff_id)` — point lookups when correlating with capture diagnostics.
- `(chain_id, created_at DESC)` — chain timeline.
- `(workflow_id)` — workflow-level analysis.
- `(call_group_id)` — group the primary + fallback rows of one evaluator invocation.
- `(outcome)` — failure-mode filter.

Notes:

- Two rows on fallback share a `call_group_id`. The CLI inspect view groups them visually (newest-first ordering plus shared `handoff_id` and `call_group_id` keeps them adjacent).
- The orchestrator's outer retry (see `relay-orchestrator.ts:129` `evaluateWithRetry` — retries the whole `evaluate()` once on failure) produces a **second** `call_group_id` for the same `handoff_id`. Two `call_group_id` values under one `handoff_id` is the signature of "orchestrator retry happened." Up to 4 rows per handoff worst case: attempt-1-primary, attempt-1-fallback, attempt-2-primary, attempt-2-fallback.
- 500-char sample size (vs Phase 1's 200) because evaluator payloads carry the captured handback text plus root request plus workflow context; 200 wouldn't surface enough of the handback to recognize what the LLM judged.

## Observer hook on `createRelayOrchestratorEvaluator`

```ts
// Telemetry-only context. Never serialized to the LLM.
export type ObserverContext = {
    handoffId: string;
    collabId: string;
    chainId: string | null;
    workflowId: string | null;
    phaseRunId: string | null;
};

// The wrapper the orchestrator now passes to evaluate(). `payload` is the
// existing EvaluatorInput / WorkflowEvaluatorInput — what the LLM sees.
// `context` is metadata for telemetry only.
export type EvaluatorCall = {
    payload: EvaluatorAnyInput;
    context: ObserverContext;
};

export type EvaluatorCallEvent = {
    callGroupId: string;             // UUID; shared by primary + fallback events of one invocation
    context: ObserverContext;        // copied through from the call so the observer can record IDs
    branch: "legacy" | "review" | "delivered" | "execution";
    provider: "anthropic" | "ollama";
    attemptKind: "primary" | "fallback";
    outcome: "ok" | "parse_error" | "validation_error" | "provider_unavailable" | "unknown_error";
    latencyMs: number;               // measured inside the factory, around just this provider call
    rawResponse: string | null;      // null only when no response arrived (provider unavailable)
    error: Error | null;
    verdict: EvaluatorAnyVerdict | null;
    inputTokens: number | null;
    outputTokens: number | null;
    systemPrompt: string;
    payload: EvaluatorAnyInput;      // the same payload the LLM saw
};

export function createRelayOrchestratorEvaluator(input: {
    primary: EvaluatorProviderConfig;
    fallback?: EvaluatorProviderConfig;
    onCall?: (event: EvaluatorCallEvent) => void;
}): (call: EvaluatorCall) => Promise<EvaluatorAnyVerdict>;
```

Note: the returned function's signature changes from `(payload) => ...` to `(call: EvaluatorCall) => ...`. The orchestrator is the only caller (passes through `createRelayOrchestrator({ evaluate, ... })`); the type change is internal to ai-whisper and has no external API impact.

**Contract:**

- `onCall` fires **exactly once per LLM call** — so twice when fallback fires (once with `attemptKind: "primary"`, once with `attemptKind: "fallback"`). Both events for one invocation share the same `callGroupId`.
- Fires **after** each underlying call resolves or throws. The outer evaluator's return-vs-throw semantics are unchanged.
- Synchronous. Recording into SQLite is fast; if a future observer is async we can revisit.
- Observer errors are caught and logged via `console.warn`; they must not break the relay path (same rule as Phase 1's capture diagnostic write).

**Latency measurement happens inside the factory**, around each provider call (`Date.now()` immediately before the underlying Anthropic/Ollama call, again immediately after it resolves or throws). The orchestrator's outer wrapping would include parsing + zod validation + branch selection overhead, which is not what we want to measure. The factory is the only place with per-LLM-call boundaries.

**Internal plumbing change required:** the Anthropic and Ollama caller functions currently return `Promise<string>` (raw response). To surface token usage, they're refactored to return `Promise<{ raw: string; inputTokens?: number; outputTokens?: number }>`. Anthropic populates `usage` from `response.usage`; Ollama leaves it undefined. The branch dispatcher passes through to the observer.

### Outcome classification

Each thrown error inside the factory is mapped to exactly one `outcome` value. The mapping is deterministic and must be implemented as an explicit switch in the factory:

| Outcome | Trigger | Specific error shape |
|---|---|---|
| `"ok"` | The underlying provider call resolved AND the regex match found a JSON object AND `JSON.parse(...)` succeeded AND `schema.parse(...)` succeeded. | — |
| `"parse_error"` | Either the regex `raw.match(/\{[\s\S]*\}/)` returned null (no JSON object in the response), OR `JSON.parse` threw. | `Error: "No JSON object found in evaluator response"` OR `SyntaxError` from `JSON.parse`. |
| `"validation_error"` | `JSON.parse` succeeded but `schema.parse` (zod) threw. | `ZodError` (matched via `error instanceof z.ZodError`). |
| `"provider_unavailable"` | The provider call itself threw before returning a response. | Matched by the existing `isProviderUnavailableError(err)` helper: `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT` / `ECONNRESET` / HTTP 429 / HTTP 5xx. |
| `"unknown_error"` | Any thrown error not matched above. | Anything else. Logged with full stack via `console.warn` so we can refine the mapping if a new failure mode shows up. |

**Required tests** (in `test/relay-orchestrator-evaluator.test.ts`):

- LLM returns a string without `{` anywhere → `parse_error`.
- LLM returns `{ this is not valid JSON }` → `parse_error`.
- LLM returns `{ "verdict": "invalid_value" }` → `validation_error` (zod discriminated-union miss).
- LLM returns valid shape but with `confidence: "high"` (wrong type) → `validation_error`.
- Provider mock throws `Object.assign(new Error("conn refused"), { code: "ECONNREFUSED" })` → `provider_unavailable`.
- Provider mock throws `Object.assign(new Error("rate limited"), { status: 429 })` → `provider_unavailable`.
- Provider mock throws plain `new Error("something else")` → `unknown_error`.

## Integration wiring

There is **one construction site**: `packages/cli/src/bin/broker-daemon.ts` (around line 53, where `createRelayOrchestratorEvaluator(...)` is called and the result is passed to `createRelayOrchestrator` as `evaluate`).

The broker-daemon passes an `onCall` callback that:

1. Generates `evaluator_id` (`eval_<digits-iso>_<random8>`).
2. Reads handoff context from `event.context` (NOT from `event.payload`).
3. Honors `AI_WHISPER_NO_EVAL_SAMPLES=1`: NULL `prompt_sample` and `response_sample`; lengths / scores / verdict / tokens still recorded.
4. Calls `broker.control.recordEvaluatorDiagnostic({...})` inside `try { } catch (err) { console.warn(...) }`. The wrapper is **required**, not optional — same Phase 1 rule.

The orchestrator's responsibility is to construct the `EvaluatorCall` wrapper on every evaluator call: bundle the existing `EvaluatorAnyInput` payload with a freshly-built `ObserverContext`. It already knows `collabId` (constructor arg) and `handoffId` (per-iteration from `claimed.handoffId`); workflow branches set `workflowId` / `phaseRunId` from the workflow metadata it already fetches. `chainId` reads off the claimed handoff record. None of these IDs reach the LLM — only the existing `payload` fields do.

### Orchestrator outer retry

`relay-orchestrator.ts:129` `evaluateWithRetry` wraps `input.evaluate(call)` with a single retry on failure. Each retry produces its own `callGroupId` (the factory generates a fresh UUID per invocation, regardless of whether the outer wrapper retried). The acceptance test list calls this out so implementers don't accidentally reuse the same `callGroupId` across attempts.

## CLI surface — `whisper collab inspect --verdicts`

Three forms, exact parallel to `--captures`:

- `whisper collab inspect --verdicts` — last 20 rows for the active collab, newest first.
- `whisper collab inspect --verdicts <chain_id>` — filter to one chain, scoped to the active collab (`collab_id = ? AND chain_id = ?` — same defense-in-depth as the `--captures` chain fix).
- `whisper collab inspect --verdicts all` — every row for the active collab (no LIMIT clause; `limit: null` pattern).

All three compose with `--watch` (reuses the inspect-watch redraw loop).

`--verdicts` and `--captures` are mutually exclusive — passing both throws at parse/action time (commander has already registered both options; the check runs in the action callback before calling `runCollabInspect`).

Rendered table:

```
TIME      BRANCH   PROVIDER   ATTEMPT   OUTCOME              VERDICT       CONF  LAT(ms)  TOK(in/out)  HANDOFF              REASON
12:00:01  legacy   anthropic  primary   ok                   done          0.85  812      812/96       handoff_abc1         deliverable matches request
12:00:02  review   ollama     fallback  ok                   approve       0.78  2140     -/-          handoff_abc2         reviewer signaled approval
12:00:01  review   anthropic  primary   provider_unavailable  -            -     5012     -/-          handoff_abc2         ECONNREFUSED
```

Sample text is truncated to 60 chars in the view (full text in DB).

New formatter `packages/cli/src/runtime/operator-inspect-verdicts.ts` (parallel to `operator-inspect-captures.ts`). `runCollabInspect` gains a `verdicts?: true | string` parameter alongside `captures?: true | string`. The two flags are mutually exclusive at the CLI layer.

## Retention

The `createDiagnosticsSweep` module added in Phase 1 currently runs one `DELETE` against `relay_capture_diagnostics`. Extend its `tick()` to also `DELETE FROM relay_evaluator_diagnostics WHERE created_at < ?` with the same cutoff. Same module, same timer, two DELETEs.

Existing env vars cover both tables — no new knobs:

- `AI_WHISPER_DIAGNOSTICS_SWEEP_MS` (default 1h)
- `AI_WHISPER_DIAGNOSTICS_RETENTION_DAYS` (default 30)

## Resolved Decisions

- **Use-case scope:** both correctness review (verdict / reason / samples) and infra reliability (provider / latency / outcome / tokens) are first-class — wide column set, no hierarchy.
- **Fallback recording:** two rows per fallback event, linked via shared `call_group_id` (a UUID generated by the factory and threaded through the observer event itself). Trade-off: doubled row volume on fallback days; payoff: full visibility into primary's failure mode, and correlation is robust against insert failures on either row.
- **`evaluator_id` uniqueness:** `eval_<digits-iso>_<random8>`. The timestamp prefix is for log readability; the random suffix prevents collisions when one handoff fires multiple LLM calls within a millisecond (orchestrator outer retry × primary/fallback × fast tests).
- **Latency ownership:** measured inside the evaluator factory around each provider call. The orchestrator does not measure — its `evaluateWithRetry` boundary would include parsing and zod validation overhead.
- **Outcome classification:** explicit error-shape mapping inside the factory (`ZodError` → `validation_error`; `SyntaxError` or "no JSON object found" → `parse_error`; `isProviderUnavailableError` matches → `provider_unavailable`; else → `unknown_error`). Tested per failure mode.
- **Token columns:** included in v1 as nullable. Anthropic populates; Ollama leaves NULL. Allows cost analysis from day one without committing to a query API.
- **Observer location:** `onCall` callback on the evaluator factory, fires once per LLM call. Twice on fallback. Evaluator's outer return type unchanged.
- **Wiring point:** single construction site — `packages/cli/src/bin/broker-daemon.ts`. `workflow-driver.ts` does not call the evaluator (verified during brainstorming review).
- **Observer context isolation:** the evaluator's call signature changes from `(payload) => Promise<verdict>` to `(call: { payload, context }) => Promise<verdict>`. Only `payload` is `JSON.stringify`ed into the LLM user message; `context` (handoff/collab/chain/workflow/phase IDs) reaches the observer only. Prevents telemetry IDs from leaking to the LLM provider — a privacy/PII concern that would otherwise grow as the context shape expands.
- **Substrate:** SQLite sidecar table. Cross-table JOIN with `relay_capture_diagnostics` for end-to-end chain debugging is the killer feature; JSONL deferred indefinitely.
- **Sample size:** 500 chars (vs Phase 1's 200). Evaluator payloads carry handback + root request + workflow context; 200 wouldn't show the handback.
- **Privacy:** opt-out via `AI_WHISPER_NO_EVAL_SAMPLES=1`. Mirrors `AI_WHISPER_NO_CAPTURE_SAMPLES=1`. Samples on by default.
- **Sweep host:** existing `diagnostics-sweep` module extended; no new timer.
- **CLI mutual exclusion:** `--verdicts` and `--captures` are mutually exclusive on `inspect`. Combining them is a CLI error.

## Open Questions

_None for v1. Cost-rollup queries and streaming-evaluator semantics will be revisited if either becomes a real workflow need._

## Acceptance

This work is done when:

- Every evaluator invocation (driven through `relay-orchestrator.ts`, configured at `broker-daemon.ts`) writes one row per LLM call to `relay_evaluator_diagnostics`. Fallback events produce two rows sharing one `call_group_id`. Outer orchestrator retry produces a fresh `call_group_id` for the second attempt.
- `evaluator_id` is unique across the test suite even when fake timers / repeated invocations collapse onto the same millisecond.
- Token counts (`input_tokens`, `output_tokens`) are populated for Anthropic calls and NULL for Ollama calls.
- The outcome classification table is implemented as an explicit switch in the factory; the seven required failure-mode tests (no-JSON, malformed-JSON, zod-mismatch via invalid enum, zod-mismatch via wrong type, ECONNREFUSED, HTTP 429, plain-Error) all pass with the right `outcome` value.
- Latency is measured inside the factory around each provider call, NOT around the outer `evaluate()` wrapper.
- Telemetry IDs are kept off the LLM payload: the orchestrator threads `ObserverContext` separately via `EvaluatorCall = { payload, context }`; `JSON.stringify(payload)` to the LLM never includes `handoffId` / `collabId` / `chainId` / `workflowId` / `phaseRunId`.
- Recording is wrapped in `try { } catch { console.warn(...) }` in `broker-daemon.ts` — SQLite failures never stall the orchestrator.
- `whisper collab inspect --verdicts [chainId|all] [--watch]` renders the table in all three forms, mutually exclusive with `--captures`.
- `AI_WHISPER_NO_EVAL_SAMPLES=1` nulls `prompt_sample` / `response_sample` while all other fields still record.
- The `diagnostics-sweep` timer deletes `relay_evaluator_diagnostics` rows older than 30 days at the same cadence as capture rows. Sweep test inserts ancient + recent rows, advances fake timers, asserts only recent rows survive — parallel to the existing capture-sweep test.
- `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` all clean. Required new tests:
  - `onCall` fires exactly once on success.
  - `onCall` fires exactly twice on fallback (primary `provider_unavailable` + fallback `ok`) with the same `callGroupId`.
  - Orchestrator outer retry produces a new `callGroupId` distinct from the first attempt's.
  - The broker-daemon `onCall` wrapper's `try/catch` swallows a SQLite throw without breaking the relay path.
  - Seven outcome-classification tests per the table above.
  - `JSON.stringify(payload)` in the evaluator factory (the user message sent to the LLM) contains none of `"handoffId"`, `"collabId"`, `"chainId"`, `"workflowId"`, `"phaseRunId"` — proves observer context is not leaked into the prompt.
  - Chain-scoped `--verdicts <chainId>` returns only the active collab's rows even when another collab has the same chain id (defense-in-depth, mirrors the `--captures` fix).
  - Mutual exclusion: invoking `--verdicts` and `--captures` together is a CLI error.

## Estimated Sizing

| Phase | Files touched | New code | Risk |
|---|---|---|---|
| Schema + repo + control method | ~3 (migration, repo, control + tests) | ~290 lines | Low |
| `onCall` hook on evaluator + Anthropic/Ollama caller refactor for tokens + outcome classification + latency-in-factory + `EvaluatorCall` wrapper for observer context | ~2 (evaluator + tests) | ~280 lines | Medium (Anthropic-vs-Ollama return-shape divergence; 7 outcome-classification tests; factory latency timing; signature change from `(payload) ⇒ ...` to `(call) ⇒ ...`) |
| `EvaluatorCall` context wrapper + orchestrator wiring | ~2 (evaluator types, orchestrator + tests) | ~120 lines | Low (one wiring site; orchestrator builds the `{ payload, context }` envelope per call) |
| Broker-daemon observer + diagnostic-write wrapper | ~2 (broker-daemon + tests) | ~150 lines | Medium (try/catch wrapper rule + outer-retry callGroupId test) |
| CLI formatter + `--verdicts` flag + mutual exclusion with `--captures` | ~4 (formatter, inspect, create-cli, tests) | ~280 lines | Low |
| Sweep extension | ~2 (diagnostics-sweep + test) | ~50 lines | Low |

Total: ~1150 lines across ~15 files. Roughly 95% of Phase 1's capture-reliability footprint — slightly larger because the outcome-classification + observer-event mechanics add real surface area.
