# Caller-Becomes-Implementer Role Resolution Design

**Date:** 2026-05-24
**Branch:** spec/caller-becomes-implementer

## Relationship to Prior Specs

Touches the workflow role-binding path established by:

- [`2026-04-21-autonomous-feature-workflow-design.md`](2026-04-21-autonomous-feature-workflow-design.md) — defines `whisper workflow start`, the `roleBindings` it persists, and the workflow definitions that carry `defaultImplementer` / `defaultReviewer`.

Does **not** change:

- The workflow phase pipelines, evaluator gating, or verdict vocabulary.
- The `roleBindings` shape persisted on a workflow (`{ implementer, reviewer }`).
- The `--implementer` / `--reviewer` CLI flags or their meaning.
- The mounted-session launch flow, broker daemon lifecycle, or handoff state machine.
- The two kickoff skills' fire-and-forget contract (verify readiness → `workflow start` → one-line report → exit).

## Problem

When a workflow starts without explicit role flags, roles resolve from static per-definition defaults — `defaultImplementer: "claude"`, `defaultReviewer: "codex"` for both `spec-driven-development` and `ralph-loop` (`packages/broker/src/runtime/workflow-registry.ts`). `runWorkflowStart` fills missing roles purely from those defaults (`packages/cli/src/commands/workflow/start.ts:59-60`) and **never consults which agent triggered the run**.

Both kickoff skills (`ai-whisper-sdd`, `ai-whisper-ralph`) invoke `whisper workflow start` with no role flags. The consequence: if Codex triggers `/aiw-sdd`, Claude is still the implementer and Codex the reviewer. The agent the user is driving from has no bearing on who implements.

This is the wrong default. It is not the tool's job to pick which model implements — some users trust Claude to implement, some trust Codex. The agent the user invokes the workflow from is a direct, intentional signal of who they want at the keyboard. The triggering agent should become the implementer, and the other agent the reviewer, unless the user explicitly overrides with flags.

## Goal

The agent that triggers a workflow becomes the implementer; the other mounted agent becomes the reviewer. Explicit `--implementer` / `--reviewer` flags always win. When no caller can be detected and no flags are given, behavior falls back to today's static default, but the CLI warns that it guessed.

## Design

Two pieces: a way for the triggering agent's identity to reach `whisper workflow start`, and role-resolution logic that consumes it.

### 1. Identity injection — `AI_WHISPER_AGENT`

A mounted agent runs the real provider CLI in a PTY (`packages/adapter-claude/src/create-claude-live-session.ts`, `packages/adapter-codex/src/create-codex-live-session.ts`). Today the PTY spawn passes no explicit `env`, so the provider inherits the mount process environment. Any `whisper …` command the agent shells out to (including the skill's `whisper workflow start`) inherits that same environment.

Each adapter live-session is inherently agent-specific — the Claude adapter only ever runs Claude, the Codex adapter only ever runs Codex. So each stamps its own identity into the PTY environment with no plumbing through `mount`:

- Claude PTY spawn: `env: { ...process.env, AI_WHISPER_AGENT: "claude" }`
- Codex PTY spawn: `env: { ...process.env, AI_WHISPER_AGENT: "codex" }`

`node-pty` replaces (does not merge) the child environment when `env` is supplied, so the spread of `process.env` is required to preserve the inherited broker variables (`AI_WHISPER_BROKER_*`, `AI_WHISPER_COLLAB_ID`, `AI_WHISPER_WORKSPACE_ROOT`).

The variable name `AI_WHISPER_AGENT` joins the existing `AI_WHISPER_*` family and is automatically covered by the launcher's `AI_WHISPER_*` passthrough filter, so it survives the auto-launch path as well as the manual `whisper collab mount <agent>` path.

### 2. Role resolution — `resolveRoleBindings`

Extract a pure function in `packages/cli/src/commands/workflow/start.ts`:

```ts
type Agent = "claude" | "codex";

function resolveRoleBindings(input: {
    explicitImplementer?: Agent;
    explicitReviewer?: Agent;
    callerAgent?: Agent | null;
    def?: { defaultImplementer?: Agent; defaultReviewer?: Agent };
}): {
    implementer: Agent;
    reviewer: Agent;
    source: "explicit" | "caller" | "default";
    warning?: string;
};
```

`other(agent)` returns the opposite agent (`claude` ⇄ `codex`).

Resolution precedence, highest first:

1. **Explicit flags.** If either `--implementer` or `--reviewer` is supplied, this is an explicit assignment. The missing side is filled as `other(...)` of the supplied side. If both are supplied they are used as-is. `source: "explicit"`. (A nonsensical pair where both flags name the same agent is rejected — see Validation.)
2. **Caller-derived.** No flags, `callerAgent` known: `implementer = callerAgent`, `reviewer = other(callerAgent)`. `source: "caller"`.
3. **Definition default + warning.** No flags, no caller: `implementer = def.defaultImplementer`, `reviewer = def.defaultReviewer`. `source: "default"`, and `warning` is set to a message stating no triggering agent was detected and roles defaulted to implementer=`<x>`/reviewer=`<y>`, suggesting `--implementer`/`--reviewer` for control. If the definition has no defaults either, throw the existing "no default role bindings" error.

`runWorkflowStart` gains an optional `callerAgent?: Agent | null` dep, calls `resolveRoleBindings`, persists the resolved bindings, and returns the optional `warning` alongside `workflowId`.

### 3. CLI wiring

In `create-cli.ts`, the `workflow start` action:

- reads and validates `process.env.AI_WHISPER_AGENT` — accepts only `"claude"` or `"codex"`; any other/absent value resolves to `null`;
- passes it as `callerAgent`;
- prints any returned `warning` to **stderr** (so it does not corrupt the `Workflow started: <id>` stdout line the skills parse).

### 4. Skills + docs

- `ai-whisper-sdd/SKILL.md` and `ai-whisper-ralph/SKILL.md`: replace the "CLI fills SDD/ralph defaults: implementer=claude, reviewer=codex" note with: the triggering agent becomes the implementer and the other becomes the reviewer; pass `--implementer` / `--reviewer` to override. Keep the no-flags invocation in the kickoff command.
- `README.md`: the "Magic moment" → "Implementer / reviewer assignment" bullet currently states "for `spec-driven-development` the default is implementer = Claude, reviewer = Codex". Reword it to describe caller-becomes-implementer (the agent you trigger the workflow from implements; the other reviews; override with `--implementer` / `--reviewer`). This surface is mandatory: leaving it stale satisfies the enumerated doc list while preserving a user-facing contradiction with the acceptance criterion below.
- `docs/workflows.md` — **conditional.** This file is not present on this feature branch; it is authored on a separate, not-yet-merged docs branch (`docs/workflows-guide`) which carries its own caller-becomes-implementer wording. Update it **only if it is present in the working tree** at implementation time; if absent, it is out of scope for this branch (do **not** create or restore it here — that would fork a file owned by the docs branch). The README link to it, if any, is handled on that branch.

**Stale-wording scan (scoped).** No *live, user-facing* doc may continue to assert that the implementer defaults to Claude (or the reviewer to Codex) regardless of caller. The scan is deliberately narrow:

- **In scope:** `README.md`; live top-level docs `docs/*.md` (e.g. `concepts.md`, `evaluator-configuration.md`, `relay-handoff-flows.md`, and `workflows.md` when present); and bundled skills under `packages/cli/skills/`.
- **Explicitly excluded:** `docs/superpowers/` (historical specs and plans). These are immutable design records of past work — this spec **supersedes** their role-assignment statements rather than rewriting them. Rewriting historical records is out of scope and a non-goal.
- A grep-style check (e.g. `rg -i "implementer\s*=\s*Claude, reviewer\s*=\s*Codex"` and "default … implementer = Claude") over the in-scope paths must return no live claim of a caller-independent Claude default. The only permitted mention of the claude/codex pairing is as the documented *unknown-caller fallback* (and the workflow definitions' `defaultImplementer` / `defaultReviewer`, which remain that fallback).

## Validation

- Unknown / malformed `AI_WHISPER_AGENT` (not `claude`/`codex`) is treated as no caller, not an error.
- Explicit flags naming the **same** agent for both implementer and reviewer is rejected with a clear error (`implementer and reviewer cannot be the same agent`). This is a new guard; today the two flags are independent and an all-same pair would silently produce a same-agent workflow.
- A partial flag (`--implementer` only, or `--reviewer` only) is honored and the other role is derived as the opposite agent; it does NOT fall through to caller detection.

## Tests

Unit (`resolveRoleBindings`, pure — primary coverage):

- both flags → used verbatim, `source: "explicit"`.
- `--implementer codex` only → `{ implementer: codex, reviewer: claude }`, explicit.
- `--reviewer claude` only → `{ implementer: codex, reviewer: claude }`, explicit.
- both flags equal → throws same-agent error.
- no flags, caller `codex` → `{ implementer: codex, reviewer: claude }`, `source: "caller"`, no warning.
- no flags, caller `claude` → `{ implementer: claude, reviewer: codex }`, `source: "caller"`.
- no flags, caller null, def present → defaults used, `source: "default"`, warning set.
- no flags, caller null, def absent → throws "no default role bindings".

Integration (`runWorkflowStart`):

- persists caller-derived bindings when `callerAgent` is set and no flags.
- returns the warning when defaulting on unknown caller.
- explicit flags override a present `callerAgent`.

Adapter (identity injection):

- Claude live-session PTY spawn receives `env` containing `AI_WHISPER_AGENT: "claude"` and still carries the inherited `AI_WHISPER_*` broker vars.
- Codex live-session PTY spawn receives `env` containing `AI_WHISPER_AGENT: "codex"`.

CLI:

- `workflow start` reads `AI_WHISPER_AGENT` from the environment, passes it through, and emits the default-warning on stderr (not stdout) when caller is unknown.

Docs stale-wording scan:

- A grep-style assertion over the **in-scope** surfaces only — `README.md`, live top-level `docs/*.md`, and `packages/cli/skills/` — finds no live claim that the implementer defaults to Claude (or reviewer to Codex) independent of the caller; the claude/codex pairing appears only as the documented unknown-caller fallback. The assertion must **exclude** `docs/superpowers/` so it does not trip on historical specs/plans, and must tolerate `docs/workflows.md` being absent on this branch.

## Non-Goals

- Per-phase role swapping within a single workflow (implementer and reviewer remain fixed for a run).
- Changing the `--implementer` / `--reviewer` flag names or adding a `--caller`-style flag.
- Detecting the caller via the broker session binding instead of the environment variable (considered and deferred — see below).
- Adding more than two agents, or any change to provider support.
- Changing workflow definition defaults themselves (they remain the unknown-caller fallback).
- Rewriting historical design records under `docs/superpowers/` (specs and plans). They document past decisions and are superseded by this spec, not edited; the stale-wording scan excludes them.
- Creating or restoring `docs/workflows.md` on this branch. It is owned by the separate `docs/workflows-guide` branch; this branch updates it only if it happens to be present.

## Out-of-Scope Improvements (Considered, Deferred)

- **Broker-session-derived caller.** `runWorkflowStart` could ask the broker which agent owns the current session/turn rather than reading an env var. Single source of truth, no env plumbing — but it needs a reliable mapping from the CLI invocation to a session id, which the invocation does not currently carry. The env-var approach is simpler and works for any `whisper` subcommand an agent runs; revisit only if the env signal proves unreliable.
- **Erroring instead of defaulting on unknown caller.** Refusing to start without flags or a detected caller would match the "tool shouldn't pick roles" principle most strictly, but it breaks direct CLI use outside a mounted session. The warning-and-default path keeps that ergonomic while still nudging toward explicit control.

## Resolved Decisions

- **Identity signal:** `AI_WHISPER_AGENT`, injected into each provider PTY by its (already agent-specific) adapter live-session. No `mount` plumbing.
- **Unknown-caller fallback:** keep the definition default (implementer=claude, reviewer=codex) but print a warning to stderr that no caller was detected. Not an error.
- **Precedence:** explicit flags > caller-derived > definition default. A single flag fills the other role as the opposite agent and counts as explicit.
- **Same-agent guard:** explicit flags naming the same agent for both roles are rejected.
- **Warning channel:** stderr, to preserve the `Workflow started: <id>` stdout contract the skills parse.

## Open Questions

_None remaining. The fallback channel, identity mechanism, and precedence are resolved above._

## Acceptance

This work is done when:

- A workflow triggered from inside a mounted **Codex** session with no role flags runs with implementer=Codex, reviewer=Claude; triggered from a mounted **Claude** session, implementer=Claude, reviewer=Codex.
- Explicit `--implementer` / `--reviewer` flags override the detected caller; a single flag fills the opposite role; both flags naming the same agent are rejected with a clear error.
- `whisper workflow start` run with no flags and no `AI_WHISPER_AGENT` (e.g. a plain terminal) starts with the definition default and prints a no-caller-detected warning to stderr while keeping `Workflow started: <id>` on stdout.
- Each provider PTY is spawned with `AI_WHISPER_AGENT` set to its own agent and the inherited `AI_WHISPER_*` broker variables intact.
- Both kickoff skills and `README.md` (the "Implementer / reviewer assignment" bullet) describe caller-becomes-implementer with the explicit-flag override; `docs/workflows.md` is likewise updated **if present** on the branch (it lives on the separate `docs/workflows-guide` branch and is not created here if absent). The grep-style stale-wording scan over the in-scope surfaces only — `README.md`, live top-level `docs/*.md`, and `packages/cli/skills/`, **excluding** `docs/superpowers/` historical specs/plans — finds no doc claiming the implementer defaults to Claude (or reviewer to Codex) regardless of caller; the claude/codex pairing survives only as the documented unknown-caller fallback.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint` are green.

## Estimated Sizing

| Area | Files touched | New code | Risk |
|---|---|---|---|
| Role resolution + CLI wiring | 2 (`workflow/start.ts`, `create-cli.ts`) + tests | ~120 lines | Low |
| Identity injection | 2 (claude + codex live-session) + tests | ~30 lines | Low |
| Skills + docs | 3 (2 `SKILL.md`, `README.md`) on this branch + `workflows.md` only if present + scoped stale-wording scan test | ~25 lines | Low |
