# SDD Friction Reduction — Design

## Goal

Make the daily spec-driven-development (SDD) workflow runnable with two terminal commands and a chat-driven kickoff, replacing the current 5-step CLI ritual. Workflow lifecycle ownership moves from a separate CLI invocation into a skill the mounted agents can invoke directly.

## Motivation

Today's no-launch SDD flow requires five steps in four terminals:

1. `whisper collab start --no-launch`
2. `whisper collab relay-monitor` (terminal A — must stay running)
3. `whisper collab mount codex` (terminal B)
4. `whisper collab mount claude` (terminal C)
5. `whisper workflow start --type=spec-driven-development --spec=<path>` (terminal D)

Three concrete frictions surface from this:

- **F1.** Five steps for a daily action is too many. Most of them are bootstrap, not the actual work.
- **F2.** `mount` hard-fails unless relay-monitor is running first (gated via `isRelayMonitorConnected`). The dashboard now subsumes relay-monitor's purpose, so the gate is obsolete.
- **F3.** Kicking off the workflow from a separate CLI in a separate terminal breaks the natural "talk to the agents" flow. The user wants to brainstorm a spec with the agents, then tell the agents to run SDD on it.

The ideal flow:

```
Terminal A (claude's home):   whisper collab mount claude -- <perm-flags>
Terminal B (codex's home):    whisper collab mount codex  -- <perm-flags>

  # Brainstorm spec with agents, save to docs/spec.md
  # In either chat: "/aiw-sdd docs/spec.md"  (Claude) or "$aiw-sdd docs/spec.md" (Codex)
  # Skill verifies readiness + kicks off; agents run the workflow; user observes via dashboard.
  # When workflow terminates, agents naturally surface the result in chat.
```

## Non-goals

- Replacing the existing CLI verbs (`workflow start/resume/cancel/inspect`). They stay as the escape hatch and the skill's plumbing.
- Adding workflow types other than SDD. Ralph-loop and others use the same skill machinery later but aren't shipped here.
- Building a TUI-driven workflow launcher inside the dashboard. The dashboard is observation-only.
- Polling-based monitoring from inside the skill. Continuous polling keeps the calling agent busy, defeating the relay's idle detection — the workflow stalls. The skill is fire-and-forget.
- Removing tmux launch mode from `collab start`. It stays for users who want the magic-launch path; this spec only changes `mount` and the no-launch flow.

## Phase 1 — `mount`/`start` CLI cleanup

### 1.1 `mount` auto-creates the collab

When `whisper collab mount <agent>` runs in a workspace that has no collab, mount creates one inline (instead of erroring with "no active collab for <cwd>"). The auto-creation uses:

- `workspaceRoot = cwd`
- `displayName = basename(cwd)`
- `launchMode = "none"` (no auto-launched agent terminals)

This is the same operation `whisper collab start --no-launch` performs today, run conditionally inside `mount`'s pre-flight. The daemon spins up on first mount; the second `mount` discovers the existing collab and binds the other agent.

`whisper collab start` itself stays as a separate command for scripting / explicit prep without mounting. Out of scope: any `--name` flag override for the auto-create displayName.

### 1.2 `mount` passthrough args spawn the agent with custom flags

Mount already spawns the agent provider in the current TTY (`targetMode: "mount_current_tty"` claim → `createMountSessionRuntime` → live session launches codex/claude in-terminal). What's missing is a way to pass arbitrary args to the agent binary.

New syntax: `whisper collab mount <agent> -- <agent-args...>`. Anything after `--` is appended to the provider's default argv when the agent is spawned. Example:

```
whisper collab mount codex  -- --full-auto
whisper collab mount claude -- --dangerously-skip-permissions
```

This unblocks autonomous workflow execution, which requires full-permission mode on both agents and cannot be enabled retroactively once the agent is up.

> **Correction (2026-05-21, smoke testing):** the premise above is wrong. Mount's interactive-session spawn ALREADY injects full-permission flags by default — codex with `--dangerously-bypass-approvals-and-sandbox`, claude with `--dangerously-skip-permissions` (see `getInteractiveSessionExecArgsForTarget` in `packages/cli/src/runtime/providers.ts`). So passing those flags via `-- <args>` is redundant and can CRASH the agent on a duplicate-argument error (codex rejects a duplicated bypass flag; `--yolo` is an alias that string-dedup can't catch). The passthrough mechanism stays as a general escape hatch for OTHER flags (e.g. `-- --model gpt-5-codex`), but the documented daily flow is just `mount claude` / `mount codex` with NO permission flags. README + the SDD skill's remediation messages were corrected accordingly. Idempotent dedup was considered and rejected (aliases + repeatable value-flags need per-agent flag semantics we don't want to own).

`mount <agent>` with no `--` continues to work — same default args as today.

### 1.3 Drop the relay-monitor gate from `mount`

Remove the `isRelayMonitorConnected` polling loop in `mount.ts` (lines 124–133). Mount no longer requires a relay-monitor process to be running. Rationale:

- The dashboard observes via direct broker reads, not via relay-monitor registration (verified in commit `bc1f5ff`).
- Users who want relay-monitor running can still start it alongside; mount just doesn't gate on it.
- The post-`collab start` message text is updated to drop "before mounting providers" — the message becomes a plain "Collab started (no-launch mode)." with no relay-monitor instruction.

### 1.4 `collab status --json`

`whisper collab status` today returns human-readable text. Phase 2's skill needs a parseable readiness shape. New `--json` flag emits:

```json
{
  "collabId": "collab_xyz",
  "workspaceRoot": "/path",
  "status": "active",
  "daemon": { "host": "127.0.0.1", "port": 4311, "pid": 12345 } | null,
  "agents": [
    { "agentType": "codex",  "bindingState": "bound" | "pending_attach" | "unbound" | null },
    { "agentType": "claude", "bindingState": "bound" | "pending_attach" | "unbound" | null }
  ],
  "recovery": { "state": "normal" | "recovery_required" | "recovered" }
}
```

The state names are literal pass-throughs of the storage layer's typed values, not a remapping:

- `bindingState` matches `SessionBindingRow['binding_state']` in `packages/broker/src/storage/repositories/session-binding-repository.ts` — the third state is `"pending_attach"`, not `"pending"`.
- `recovery.state` matches `RecoveryStateValue` in `packages/broker/src/storage/repositories/recovery-state-repository.ts` — the healthy state is `"normal"`, not `"ready"`.

If a binding row doesn't exist for an agent, `bindingState` is `null` (not present in the table); the skill treats `null` the same as `"unbound"` for readiness purposes.

Plain-text output stays the default; `--json` opts in. No structural change to the underlying `resolveCollab` query; just an additional `listSessionBindings(collabId)` call and a different formatter.

### 1.5 Post-start message cleanup

In `start.ts`, the post-launch text:

```
"Collab started (no-launch mode).
Next: run \"whisper collab relay-monitor\" in a separate terminal before mounting providers."
```

becomes:

```
"Collab started (no-launch mode)."
```

The relay-monitor instruction is gone (F2). No alternative message is needed — `mount` is self-describing once the gate is removed.

### 1.6 `workflow start` defaults from the workflow type

Today `whisper workflow start` requires `--type`, `--spec`, `--implementer`, AND `--reviewer` as `requiredOption` (see `packages/cli/src/create-cli.ts:419`). The skill in Phase 2 wants to call this with just `--type` + `--spec` — having to also pass `--implementer claude --reviewer codex` every time is friction the skill shouldn't paper over.

Change: `--implementer` and `--reviewer` become `.option(...)` (not required). When omitted, the CLI fills them from the workflow definition's default role binding. For `spec-driven-development`, the convention is `implementer: claude, reviewer: codex` — these become the type's documented defaults. Explicit flags still override.

The workflow definition's role defaults are exposed via the existing `getWorkflowDefinition(type)` helper (already used by the dashboard / Inspector). If `getWorkflowDefinition(type)` does not currently carry default role bindings, they get added there as part of this work — small surface change.

Without this, the skill's command would be `whisper workflow start --type=spec-driven-development --spec=<path> --implementer=claude --reviewer=codex`, which leaks workflow-definition knowledge into the skill and would need touching every time the convention changes.

## Phase 2 — SDD skill + `whisper skill install`

### 2.1 Distribution layout

The bundled skills live **inside the CLI package** at `packages/cli/skills/<skill-name>/SKILL.md` (source) — NOT at a repo-root `skills/` directory. The CLI's build step copies this tree into `packages/cli/dist/skills/<skill-name>/SKILL.md` so the binary at `packages/cli/dist/bin/whisper.js` can resolve them via a stable path:

```
packages/cli/skills/ai-whisper-sdd/SKILL.md          # source (committed)
packages/cli/dist/skills/ai-whisper-sdd/SKILL.md     # built (gitignored, copied on `pnpm build`)
```

**Runtime lookup** in `whisper skill install` resolves the bundled-skills directory as `path.join(import.meta.dirname, "..", "skills")` from `packages/cli/dist/bin/whisper.js`. `import.meta.dirname` is `packages/cli/dist/bin/`, so `../skills` resolves to `packages/cli/dist/skills/` — the BUILT tree, not the source. This is intentional: the source `packages/cli/skills/` is the author's input; the install command reads from `dist/skills/` so it works identically in the monorepo checkout (after `pnpm build`) and in any future published-package layout (the package's `dist/` is its shipped root).

A `pnpm build` is therefore a prerequisite of `whisper skill install` — the missing-source-dir error in section 2.5 testing makes this explicit.

**Build wiring**: `packages/cli/package.json`'s `build` script currently runs `tsc -p tsconfig.json`. It becomes a two-step:

```json
"build": "tsc -p tsconfig.json && node scripts/copy-skills.mjs"
```

`scripts/copy-skills.mjs` is a tiny in-package node script that recursively copies `packages/cli/skills/` → `packages/cli/dist/skills/`. No external dep; uses `node:fs/promises` `cp` with `{ recursive: true }`. Listed as `files: ["dist", "skills"]` in `package.json` so both the source AND the copied dist tree are included if/when the package is published — defensive against a consumer using `npx @ai-whisper/cli` against the source layout.

Future skills (ralph-loop, etc.) ship as siblings: `packages/cli/skills/ai-whisper-ralph-loop/SKILL.md`. `whisper skill install` walks the resolved bundled-skills directory and copies every subdirectory it finds.

**Gitignore**: `packages/cli/dist/skills/` is already covered by the existing `**/dist/**` ignore — no additional `.gitignore` entries.

### 2.2 `whisper skill install` command

```
whisper skill install [--target=<claude|codex|all>] [--force]
```

- `--target=all` (default) — copies every bundled skill into both `~/.claude/skills/` and `~/.codex/skills/`.
- `--target=claude` / `--target=codex` — single destination.
- `--force` — overwrite existing destinations. Without it, the command refuses to overwrite and reports which skills are already present.

The command locates the bundled skills directory using the resolution rule in 2.1 (`path.join(import.meta.dirname, "..", "skills")` from `packages/cli/dist/bin/whisper.js`, i.e., `packages/cli/dist/skills/`). Missing destinations are created (`mkdir -p`).

### 2.3 SDD skill content (`skills/ai-whisper-sdd/SKILL.md`)

Frontmatter:

```yaml
---
name: ai-whisper-sdd
description: Kick off the spec-driven-development workflow on a given spec file. Use when the user says things like "run SDD on <path>", "kick off spec-driven-development with <path>", "/aiw-sdd <path>", or "$aiw-sdd <path>".
---
```

Body instructs the agent to:

1. **Resolve the spec path** the user named. If unclear, ask once before doing anything.
2. **Verify readiness** by running `whisper collab status --json` and parsing the result. Required: `daemon !== null`, `status === "active"`, `recovery.state === "normal"`, both `agents[*].bindingState === "bound"`. If `recovery.state` is `"recovery_required"` the skill bails with the existing remediation (`whisper collab recover`); if `"recovered"`, it bails with `whisper collab reconnect <agent>`.
3. **Verify the spec file** is readable (Read tool).
4. **On any readiness gap, bail with a clear message**: name the missing piece and the exact command to fix. Examples:
   - *"No collab found in this workspace. Run `whisper collab mount codex -- --full-auto` in one terminal and `whisper collab mount claude -- --dangerously-skip-permissions` in another, then re-run this skill."*
   - *"Codex is not mounted (current bindingState: `unbound`). Run `whisper collab mount codex -- --full-auto` in a separate terminal, then re-run this skill."*
   - *"Spec file `<path>` is not readable. Check the path and try again."*
5. **Kick off**: run `whisper workflow start --type=spec-driven-development --spec=<path>`. Capture the workflowId from the output.
6. **Report and exit**: print a single line — *"Workflow `<id>` started. Track progress in the dashboard (`whisper collab dashboard`)."* — then the skill is done. No polling, no continued narration.

The skill explicitly does NOT poll the workflow's status. Continuous polling from inside the calling agent keeps that agent busy (output appears in its terminal), which prevents the broker from detecting the agent as idle, which blocks handoff delivery — the workflow stalls. The skill is one-shot kickoff only.

### 2.4 Trigger model

Description-driven only. Both Claude Code and Codex surface installed skills in their respective pickers (`/` for Claude, `$` for Codex). The description field teaches each agent to recognize natural-language phrasings (*"run SDD on …"*, *"start spec-driven-development"*, *"kick off the workflow with @<path>"*) AND the convention forms (`/aiw-sdd <path>`, `$aiw-sdd <path>`). No real registered slash command — that's a Claude-Code-specific mechanism, not portable to Codex.

### 2.5 README requirement section

A new README section titled "Required skills" describes:

- The bundled workflows (SDD now, more later) require the corresponding skills to be installed in your agents.
- Run `whisper skill install` once after installing the CLI.
- The install location is `~/.claude/skills/` and `~/.codex/skills/`.
- Skills can be reinstalled with `whisper skill install --force` after a CLI upgrade.

## Phase 2.5 — workflow chat-report (deferred)

Out of scope for the implementing PR. Captured here so the design is honest about the gap:

The fire-and-forget skill leaves a UX hole: once the workflow terminates (done or halted), the user doesn't learn about it until they open the dashboard or ask the agent. The natural fix is to bake "report to user" into the workflow definition itself — SDD's terminal phase (and halt path) emits a final handoff to the mounted terminal saying *"workflow done — here's the summary"* or *"workflow halted at phase X — reason Y. Want to resume? `whisper workflow resume <id>`"*. The user sees this in their chat as soon as the agent receives the message and goes idle.

This requires changes to the spec-driven-development workflow definition and is a separate, independently-shippable change.

## Architecture

The change touches five conceptual surfaces:

1. **CLI verbs** (`mount`, `start`, `status`, `workflow start`) — Phase 1.
2. **Workflow registry / definition shape** — Phase 1.6 adds default role bindings (implementer/reviewer) per workflow type. `getWorkflowDefinition(type)` grows fields that `workflow start` reads when its `--implementer` / `--reviewer` flags are omitted.
3. **CLI verbs** (new `skill install`) + CLI build wiring (`scripts/copy-skills.mjs`) — Phase 2.
4. **Repo content** (`packages/cli/skills/ai-whisper-sdd/SKILL.md`) — Phase 2.
5. **Docs** (README + this spec + a follow-on plan) — both phases.

No broker control-service changes are needed for either phase. The `listSessionBindings` query Phase 1.4 uses already exists; the `workflow start` CLI Phase 2.3 calls is already shipped (Phase 1.6 only relaxes its required-options).

New code surfaces:

- CLI command wiring for the new `skill install` verb.
- A skill markdown file (`packages/cli/skills/ai-whisper-sdd/SKILL.md`).
- A small file-copy implementation: `scripts/copy-skills.mjs` (build-time) + the install handler (runtime).
- **Workflow type metadata** for default role bindings, exposed through `getWorkflowDefinition(type)`. For `spec-driven-development`: `{ defaultImplementer: "claude", defaultReviewer: "codex" }`.
- **`workflow start` default resolution** in `packages/cli/src/commands/workflow/start.ts` (or its caller in `create-cli.ts`): when `--implementer` / `--reviewer` are not passed, look up the type's default and use it; if the type has no default and the flag wasn't passed, emit the existing "required option" error with a clearer "this workflow type has no default — pass --implementer/--reviewer explicitly" message.

## Data flow

**Mount (Phase 1):**

```
user → `whisper collab mount codex -- --full-auto`
  → mount.ts:
      resolveCollab(cwd) → none?  → run collab-start-no-launch inline (1.1)
      [removed: isRelayMonitorConnected poll]  (1.3)
      issueAttachClaim(...)
      createMountSessionRuntime({ target, ttyPath, claimId, passthroughArgs: ["--full-auto"] })  (1.2)
        → spawn codex in current TTY with the augmented argv
```

**Skill kickoff (Phase 2):**

```
user → "/aiw-sdd docs/spec.md" in codex chat
  → codex picks the ai-whisper-sdd skill
  → skill body executes:
      1. bash: whisper collab status --json
      2. parse: daemon, status, bindingState × 2
      3. Read: docs/spec.md  (verify readable)
      4. on any miss → format remediation message → done
      5. bash: whisper workflow start --type=spec-driven-development --spec=docs/spec.md
           (no --implementer / --reviewer needed; CLI fills SDD defaults per 1.6)
      6. parse workflowId from stdout
      7. print: "Workflow <id> started. Track in dashboard."
  → codex's terminal returns to idle
  → broker workflow driver picks up the workflow, queues handoffs
```

## Error handling

- **Phase 1.1 (auto-create race):** if two `mount` commands race to create the collab from the same workspace, the second should observe the first's row and bind without error. Mount's collab-create path runs the same insert that `collab start` runs today (single SQL insert; primary-key collision throws, but resolveCollab is rerun on retry).
- **Phase 1.2 (passthrough args injection):** user-supplied args are appended verbatim to the agent's argv. The CLI does not sanitize or shell-escape — commander's `--` passthrough yields a clean string[] which goes directly into the spawn's argv array (no shell). Tests cover that ENV vars set by mount aren't overridden by user args (mount's `AI_WHISPER_*` env stays authoritative).
- **Phase 1.3 (no relay-monitor):** mount succeeds even when no monitor is connected. Existing tests for "relay-monitor required" are removed; new tests assert mount completes without one.
- **Phase 1.4 (--json):** plain text is the default. `--json` must not break callers parsing the plain output; we add the flag without changing the default branch.
- **Phase 2 (skill bail messages):** every readiness-failure path produces a structured message with the missing piece + remediation command. Tests for the skill body itself aren't in scope (skills are markdown — agent execution isn't reproducible in unit tests), but the CLI verbs they call are tested.
- **Phase 2 (skill install collisions):** `whisper skill install` without `--force` refuses to overwrite any existing `<dest>/<skill-name>/SKILL.md`. With `--force`, it overwrites and prints what was replaced.

## Testing rigor

**Phase 1:**

- Unit: `mount` auto-creates collab when none exists (insert + bind in one transaction).
- Unit: `mount` passes user `--`-args to the provider spawn's argv (mock `createMountSessionRuntime`, assert the passthrough flows through).
- Unit: `mount` no longer requires relay-monitor (no `isRelayMonitorConnected` polling; existing test that expected the error is removed).
- Unit: `collab status --json` emits the documented shape with literal storage-layer state names (`"pending_attach"`, `"normal"`, etc.). Matrix covers: all bindingState values × all recovery.state values × daemon-present/absent.
- Unit: `workflow start` succeeds without `--implementer` / `--reviewer` for known workflow types (1.6); SDD defaults to implementer=claude, reviewer=codex; explicit flags still override; an unknown type without defaults still errors with a clear message.
- Existing tests for `collab start` post-message updated to match new text.

**Phase 2:**

- Unit: `whisper skill install` copies bundled skills from `packages/cli/dist/skills/` to the right destinations.
- Unit: `--target=claude` / `--target=codex` / `--target=all` each copy to the correct subset.
- Unit: `--force` overwrites; without `--force`, existing destinations cause a refusal (skill files preserved).
- Unit: missing source directory (e.g., build hasn't run) is a clear error pointing at `pnpm build`, not a partial copy.
- Integration (real fs): a temp `~/.fake-home` is used; install runs against it; both expected paths are created with the SKILL.md content intact.
- Build-time: `scripts/copy-skills.mjs` is exercised by `pnpm -F @ai-whisper/cli build` — assert `packages/cli/dist/skills/ai-whisper-sdd/SKILL.md` exists post-build (this can be a `test/cli-skills-build.test.ts` that runs the script in a sandbox dir and inspects the result).

## Acceptance criteria

- The two-terminal daily flow is the documented happy path in the README:
  ```
  whisper collab mount claude -- --dangerously-skip-permissions
  whisper collab mount codex  -- --full-auto
  # …spec brainstorm in chat…
  # /aiw-sdd docs/spec.md  (or $aiw-sdd …)
  ```
- `mount` does not require relay-monitor to be running.
- `mount` auto-creates a collab if none exists for cwd.
- `mount` accepts `-- <args>` passthrough.
- `collab status --json` returns the documented shape, with `bindingState` values from `{ "bound", "pending_attach", "unbound", null }` and `recovery.state` values from `{ "normal", "recovery_required", "recovered" }` — exactly mirroring the storage layer's typed values.
- `whisper workflow start --type=spec-driven-development --spec=<path>` succeeds without explicit `--implementer` / `--reviewer` flags.
- `whisper skill install` ships `ai-whisper-sdd` to `~/.claude/skills/` and `~/.codex/skills/` by default.
- The README has a "Required skills" section linking to this spec.
- The full test suite stays green.

## Open questions

None as of brainstorming close (2026-05-20). Phase 2.5 is deferred by design, not by uncertainty.
