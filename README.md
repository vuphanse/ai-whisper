# ai-whisper

Local collaboration bridge for paired AI agent sessions.

## Current Scope

This repository is being built in incremental phases. Phase 7 is complete and delivers recovery, operator monitoring, terminal-first mounted sessions, and the relay orchestrator on top of the Phase 6 in-session relay: `whisper collab` startup and lifecycle commands, real Codex and Claude providers, broker-backed turn routing, active-thread-aware relay semantics, concise inline acknowledgement and reply summaries, mounted baton-handoff workflow, and LLM-based post-handback orchestration. Multi-phase autonomous workflows (e.g. `superpowers-feature-development`) run on top of the same relay. Earlier `attach` and `adopt` flows (Phase 7A / 7D) have been shelved; see [`docs/legacy-attach.md`](docs/legacy-attach.md).

For the full handoff lifecycle reference — manual chats, autonomous workflows, capture classification, hotkeys, and per-step verdicts — see [`docs/relay-handoff-flows.md`](docs/relay-handoff-flows.md).

When running from this repo checkout, build first with `pnpm build` and invoke the CLI as `node packages/cli/dist/bin/whisper.js ...`. The `whisper ...` examples below assume a packaged or globally installed CLI.

## Requirements

Interactive sessions (mounted and live-session surfaces) require `node-pty`, which is a native dependency. Local installs need a working native build toolchain available to `pnpm install` so the PTY binding can compile or load correctly.

## Workspace Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format
```

## Package Layout

- `packages/shared` - shared schemas for broker, provider, and companion contracts
- `packages/broker` - broker runtime, collaboration engine, and companion registration support
- `packages/companion-core` - generic companion runtime, provider registry, and mock provider
- `packages/cli` - `whisper` command surface with collab lifecycle and tell commands
- `packages/adapter-codex` - Codex provider
- `packages/adapter-claude` - Claude provider

## Typical Workflow

```bash
whisper collab start
```

By default, `collab start` prefers `tmux` and attaches your current terminal into the collab session with split panes when `tmux` is available. Use `--no-tmux` to launch separate terminal windows instead. Use `--no-launch` when you only want the broker and plan to `mount` providers manually.

Then inside a live session:

```text
@@codex review this plan
@@claude[new] implement the agreed changes
```

And for a brand-new thread that needs explicit artifacts:

```bash
whisper collab tell --target codex --action review_plan --artifact docs/plan.md "review this plan"
```

Other lifecycle commands:

```bash
whisper collab status
whisper collab stop
```

### Recovery workflow (Phase 7B)

If the current workspace collab still exists but the broker is gone or unusable:

```bash
whisper collab recover
whisper collab reconnect codex
whisper collab reconnect claude
```

Recovery restores durable collab state pessimistically. Previously bound roles come back degraded and must be reconnected explicitly. Run `whisper collab reconnect <role>` from the iTerm tab you want to mount as that role. Recovery also returns the broker idle; interrupted queued work does not resume automatically.

### Operator monitoring workflow (Phase 7C1)

Use the quick snapshot first:

```bash
whisper collab status
```

Inspect the active thread in more detail:

```bash
whisper collab inspect
```

Use live monitoring when a collab is active:

```bash
whisper collab inspect --watch
```

`inspect` is read-only. It shows the active thread, recent work items, recent replies, and recent failed or `recovery_blocked` activity with truncated previews by default.

Use `--captures` to surface recent auto-handback capture diagnostics for the active collab; pass a chain id (e.g. `--captures chain_abc`) to filter, or `--captures all` for the full history. Combine with `--watch` to tail.

Use `--verdicts` to surface recent evaluator (LLM verdict) diagnostics for the active collab; pass a chain id (e.g. `--verdicts chain_abc`) to filter, or `--verdicts all` for the full history. Combine with `--watch` to tail. `--verdicts` and `--captures` are mutually exclusive.

### Terminal-first mounted sessions (Phase 7E)

The preferred workflow for inline `@@` relay support. `whisper collab mount` claims the current iTerm shell as the managed session surface and launches the provider automatically:

1. `whisper collab start --no-launch`
2. in one iTerm tab, run `whisper collab mount codex`
3. in a second iTerm tab, run `whisper collab mount claude`
4. from the Codex tab, type `@@claude <instruction>` to relay to Claude with inline acknowledgement and reply

Mounted sessions keep `ai-whisper` as the terminal owner, so the live-session relay parser can intercept `@@...` input. Recovery and reconnect default to the mounted path when the previous binding was mounted.

#### Baton handoff workflow

Use mounted sessions when you want the visible Codex and Claude tabs to be the real workflow actors.

Example real use case:

- Claude reviews plan and decides Codex should implement next step
- Claude sends handoff from visible Claude tab
- Claude waits while Codex owns turn
- Codex does work in visible Codex tab
- Codex hands result back to Claude
- Claude reviews result, amends request if needed, or sends next handoff

Recommended startup:

```bash
whisper collab start --no-launch
```

Then in two normal iTerm tabs:

```bash
whisper collab mount codex
whisper collab mount claude
```

Send work from current owner:

```text
@@codex implement phase 7e handback flow
@@claude review mounted relay acceptance UX
```

What happens next:

- ownership flips immediately to target provider
- sender becomes waiting side and normal typing is blocked
- owner sees local handoff card inside mounted tab
- only one unresolved handoff is allowed at a time

Owner controls inside mounted tab:

- `a` accepts handoff immediately and injects original request into visible session
- `e` opens local editor first so owner can amend request before accepting
- `d` declines handoff and releases sender
- `space` defers handoff but keeps sender waiting

After accept, owner works normally in visible provider session. When ready to return turn:

- press `h` when mounted runtime shows `Ready to hand back`
- press `Ctrl+H` to force handback immediately if the readiness hint does not appear
- runtime tries to capture latest visible response
- if copied response looks right, press `Enter` to confirm handback
- if capture is empty or not usable, local composer opens so owner can write handback text manually

Practical guidance:

- think of relay as strict baton pass, not two active sessions typing at once
- send compact, explicit tasks so owner can accept quickly or amend locally
- use handback to return result summary or next-step request to other side
- if handoff stays deferred, sender remains blocked until owner declines, cancels, or hands turn back

> The earlier `whisper collab attach`, `whisper collab rebind`, and `--adopt-current-tty` flows (Phase 7A and Phase 7D) have been shelved. See [`docs/legacy-attach.md`](docs/legacy-attach.md) for the historical design.

### Relay Orchestrator (Phase 7F)

The relay orchestrator is an opt-in daemon that automates the post-handback judgment loop. After an agent hands back a deliverable, the orchestrator evaluates whether the work satisfies the original request — without requiring human intervention for each round.

> See [`docs/relay-handoff-flows.md`](docs/relay-handoff-flows.md) for the complete handoff state machine, capture-status table, hotkey reference, per-step verdicts, and troubleshooting guide.

#### How it works

1. Agent hands back work → handoff status becomes `handed_back`
2. Orchestrator polls and atomically claims the handoff
3. LLM evaluator judges the deliverable against the original request
4. Verdict determines next action:
   - **done** — deliverable satisfies request; chain resolves, turn returns to sender
   - **loop** — further iteration needed; orchestrator creates a new handoff with agents swapped and a composed follow-up message, incrementing the round number
   - **escalate** — ambiguous or failed evaluation; chain marked escalated, human operator takes over

The orchestrator preserves a stable `chainId` across all rounds, tracks `roundNumber`, and keeps the `rootRequestText` so each evaluation has full context. When `roundNumber` reaches `maxRounds`, the orchestrator forces escalation without calling the LLM.

If the agent response was not reliably captured (PTY failure, timeout), the orchestrator skips the LLM and re-issues the same request unchanged. Verdicts with `confidence < 0.5` are automatically escalated regardless of verdict type.

#### Automated handoff cycle in mounted sessions

Mounted sessions drive the orchestrated loop without operator keypresses. Two idle-triggered behaviours fire based on `AI_WHISPER_IDLE_THRESHOLD_MS` (default 30 s):

**Auto-accept** — when a pending handoff arrives and the provider has been idle for the threshold, the mounted runtime injects the request text into the active provider session as if the operator had pressed `a`. The provider starts working immediately.

**Auto-handback** — when the provider finishes and goes idle again for the threshold, the mounted runtime triggers `/copy` to capture the response from the provider's clipboard, then hands it back automatically. No `h` keypress needed.

The threshold must be longer than the LLM's typical response-start latency. If auto-handback fires before the provider has produced any output, the capture is empty and the orchestrator re-issues the request unchanged (see [Capture status](#capture-status)).

To disable auto-accept or auto-handback on a specific mount, set the threshold very high (`AI_WHISPER_IDLE_THRESHOLD_MS=999999`) so the automation never fires; the operator can then accept and hand back manually with `a` and `h` as usual.

#### Complete end-to-end walkthrough

Startup (three panes recommended):

```bash
# pane 1 — operator monitor
whisper collab relay-monitor

# pane 2 — codex tab
whisper collab mount codex

# pane 3 — claude tab
whisper collab mount claude
```

Initiate the chain from codex:

```text
@@claude implement the logging helper described in docs/spec.md
```

What you see in the relay-monitor pane as the cycle runs:

```
08:46:03  [codex] → [claude]:
  implement the logging helper described in docs/spec.md
08:46:03  [ai-whisper] Handed turn to claude.

● codex online - ● claude online - Turn owner: claude - Waiting: codex - Handoff: pending - Chain: active (round 1/3)

  (claude's idle threshold passes — auto-accept fires)

● codex online - ● claude online - Turn owner: claude - Waiting: codex - Handoff: accepted - Chain: active (round 1/3)

  (claude works, goes idle — auto-handback fires, clipboard captured, orchestrator evaluates)

● codex online - ● claude online - Turn owner: codex - Chain: active (round 1/3)

  (haiku returns verdict=done)

● codex online - ● claude online - Turn owner: codex - Chain: done (round 1/3)
```

If haiku returns `loop`, the monitor shows a new round starting:

```
● codex online - ● claude online - Turn owner: claude - Waiting: codex - Handoff: pending - Chain: active (round 2/3)
```

The composed follow-up message (combining original request + claude's partial result + haiku's guidance) is injected into the new handoff. Codex's waiting gate re-blocks and the cycle repeats.

#### Reading chain state

Use `whisper collab inspect` at any point:

```
Collab: collab_20260418084548371
Recovery: normal
Broker: ok
Roles:
  - codex: bound (healthy) [mounted] tty=/dev/ttys001
  - claude: bound (healthy) [mounted] tty=/dev/ttys015
Turn owner: codex
Waiting: none
Handoff state: idle
Last capture: ok
Orchestrator: yes
Chain status: done
Round: 1/3
Active Thread: none
```

Key fields when orchestrator is enabled:

| Field | Meaning |
|-------|---------|
| `Orchestrator: yes` | Broker daemon has the evaluator running for this collab |
| `Chain status: active` | A round is in progress or handoff is pending orchestrator claim |
| `Chain status: done` | Haiku returned `done`; chain resolved; no further action needed |
| `Chain status: escalated` | Orchestrator could not resolve; human operator must intervene |
| `Round: N/M` | Current round number / `maxRounds` ceiling |
| `Last capture: ok` | Most recent handback was captured reliably and sent to LLM |
| `Last capture: no_response_captured` | Provider produced nothing; request will be re-issued |

#### Capture status

Before calling the LLM, the orchestrator checks whether the provider's response was reliably captured from the PTY or clipboard. The capture status is set during auto-handback and stored on the handoff record:

| Status | What happened | Orchestrator action |
|--------|--------------|---------------------|
| `ok` | Clipboard change detected and content is ≥ 100 chars, or PTY similarity confirms the clipboard matches the visible turn | Sends captured text to LLM evaluator |
| `no_response_captured_confidently` | Clipboard changed but content is too short or does not match PTY output (possible stale clipboard) | Skips LLM; re-issues original request unchanged (increments round) |
| `no_response_captured` | Provider produced no clipboard content and PTY captured nothing | Skips LLM; re-issues original request unchanged (increments round) |

Forced re-issues count toward `maxRounds`. If the provider consistently fails to produce capturable output (e.g. verbose tool-trace output that confuses the similarity check), the chain will exhaust its rounds and escalate.

#### When the chain escalates

`Chain status: escalated` means the orchestrator stopped the automated loop. This happens when:

- `maxRounds` was reached before haiku returned `done`
- Haiku returned `verdict=escalate` (agent reported being blocked or contradictory request)
- Haiku returned any verdict with `confidence < 0.5`
- The LLM evaluator threw an error on both the primary attempt and retry

When escalation occurs:
- Turn ownership returns to the **original sender** (the agent who sent the first `@@` in the chain)
- Both agents are unblocked; no pending handoff remains
- The relay-monitor pane shows `Chain: escalated (round N/M)`

**Operator recovery steps:**

1. Run `whisper collab inspect` to see which round it escalated on and the reason (stored as the chain status detail in the broker)
2. Open the relay-monitor log to review what each round attempted
3. Decide whether to:
   - Fix the request and resend: from the sender's mounted tab, type `@@<target> <revised request>` — this starts a fresh chain
   - Check the target provider's state manually: switch to the target's tab, review what it produced, and copy the relevant output yourself before sending the next handoff
   - Increase `maxRounds` in `.env` if the task legitimately needs more iterations

There is no automatic resume from escalation. The operator must initiate the next action.

#### API cost

Each `done` or `escalate` verdict calls the LLM evaluator once (plus one retry on network/rate-limit error). A `loop` verdict also calls once. Forced re-issues due to capture failure call the LLM zero times.

With `maxRounds=3` and haiku as the evaluator, a chain that loops twice and resolves on round 3 costs three haiku calls. Chains that exhaust all rounds via forced re-issues (capture always fails) cost zero LLM calls but may still escalate.

#### Evaluator providers

The evaluator supports two providers, configurable as primary or fallback:

- **Anthropic** — uses `claude-haiku-4-5-20251001` via the Anthropic API
- **Ollama** — local models (e.g. `qwen2.5:7b-instruct`)

On network or rate-limit errors, the evaluator retries once with the fallback provider if configured. Validation errors do not trigger fallback.

#### Configuration

```bash
# Orchestrator is on by default. Set to "0" before `whisper collab start` to disable.
AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1

# Max rounds before forced escalation (default: 3)
AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS=3

# Evaluator provider: "anthropic" (default) or "ollama"
AI_WHISPER_EVALUATOR_PROVIDER=anthropic

# Optional fallback provider if primary is unavailable
AI_WHISPER_EVALUATOR_FALLBACK=ollama

# Anthropic (required when provider or fallback is anthropic)
ANTHROPIC_API_KEY=sk-...

# Ollama settings
AI_WHISPER_EVALUATOR_OLLAMA_HOST=http://localhost:11434
AI_WHISPER_EVALUATOR_OLLAMA_MODEL=qwen2.5:7b-instruct

# Idle threshold controlling auto-accept and auto-handback in mounted sessions
# Must exceed the LLM's response-start latency (default: 30000 ms)
AI_WHISPER_IDLE_THRESHOLD_MS=30000
```

When orchestrator is disabled (default), the collab uses the traditional manual relay workflow and no LLM calls are made by the broker daemon.

### Autonomous workflows

Multi-phase pipelines that drive both agents through a structured task. Today the only registered workflow type is `superpowers-feature-development`, which runs spec-refining → plan-writing → plan-execution → code-review.

Start a workflow once you have a collab running and both agents mounted:

```bash
whisper workflow start \
  --type superpowers-feature-development \
  --spec docs/path/to/spec.md \
  --implementer claude \
  --reviewer codex
```

What the workflow does:

- **Phase 0 — spec-refining** (review-loop, maxRounds=5): reviewer reads the spec; either approves or returns findings; implementer addresses findings; loops until approve or escalate.
- **Phase 1 — plan-writing** (review-loop, maxRounds=5): implementer writes a plan file; reviewer judges; loops until approve.
- **Phase 2 — plan-execution** (execution-gate, maxRounds=1): implementer runs the plan and commits; orchestrator judges execution-pass / execution-fail / escalate.
- **Phase 3 — code-review** (review-loop, maxRounds=5): reviewer reviews the commits; loops until approve or halt.

While a workflow is running the manual hotkeys (`a/e/d/h/space/Ctrl+H`) are no-ops — the broker drives the chain. Operators observe via `whisper collab relay-monitor` and the SQLite tables (`workflows`, `relay_chains`, `relay_handoff`).

Other workflow commands:

```bash
whisper workflow list
whisper workflow inspect <workflowId>
whisper workflow resume <workflowId>
whisper workflow cancel <workflowId>
whisper workflow types
```

For the per-step verdict vocabulary, halt conditions, and inspection cookbook, see [`docs/relay-handoff-flows.md`](docs/relay-handoff-flows.md#2-autonomous-workflows).

## Phase Roadmap

- Phase 1: foundation
- Phase 2: shared contracts and broker skeleton
- Phase 3: collaboration and thread engine
- Phase 4: companion runtime and generic provider layer
- Phase 5: CLI-first MVP
- Phase 6: in-session relay workflow
- Phase 7: attach, recovery, and operator tooling
  - 7A: attach workflow — _shelved, see [`docs/legacy-attach.md`](docs/legacy-attach.md)_
  - 7B: recovery workflow
  - 7C1: operator monitoring
  - 7D: adopt existing provider sessions — _shelved, see [`docs/legacy-attach.md`](docs/legacy-attach.md)_
  - 7E: terminal-first mounted sessions
  - 7F: relay orchestrator
