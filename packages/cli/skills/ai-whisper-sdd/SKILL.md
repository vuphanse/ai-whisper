---
name: ai-whisper-sdd
description: Kick off the spec-driven-development (SDD) workflow on a given spec file. Use when the user says things like "run SDD on <path>", "kick off spec-driven-development with <path>", "/aiw-sdd <path>", "$aiw-sdd <path>", or otherwise asks to start the spec-driven-development workflow on a specific spec file.
---

# ai-whisper-sdd

Kick off the ai-whisper spec-driven-development (SDD) workflow on a specific spec file. This skill is fire-and-forget: it verifies the collab is ready, runs `whisper workflow start`, and exits. **Do NOT continue polling or narrating after kickoff** — continuous activity from the calling agent keeps it busy, which blocks the broker's idle detection and stalls the workflow. The dashboard (`whisper collab dashboard`) is the inspection surface during the run.

## When to invoke

Match phrases like:
- *"run SDD on docs/spec.md"* / *"kick off spec-driven-development with @docs/spec.md"*
- *"/aiw-sdd docs/spec.md"* (Claude picker form)
- *"$aiw-sdd docs/spec.md"* (Codex picker form)

If the user references a spec ambiguously (e.g., "run SDD on the spec we just wrote"), ASK them for the path ONCE before proceeding. Do not guess.

## Steps

### 1. Resolve the spec path

The user names a path. If it begins with `@`, strip the `@`. Resolve to an absolute path. Verify it's a readable file via the Read tool. If not readable:

> Spec file `<path>` is not readable. Check the path and try again.

### 2. Verify collab readiness

Run:

```bash
whisper collab status --json
```

Parse the JSON. The expected shape is:

```json
{
  "collabId": "collab_xyz",
  "workspaceRoot": "/path",
  "status": "active",
  "daemon": { "host": "127.0.0.1", "port": 4311, "pid": 12345 },
  "agents": [
    { "agentType": "codex",  "bindingState": "bound" | "pending_attach" | "unbound" | null },
    { "agentType": "claude", "bindingState": "bound" | "pending_attach" | "unbound" | null }
  ],
  "recovery": { "state": "normal" | "recovery_required" | "recovered" }
}
```

Required for readiness:
- `daemon !== null`
- `status === "active"`
- `recovery.state === "normal"`
- BOTH `agents[*].bindingState === "bound"` (for `codex` AND `claude`)

If the JSON has `{ "error": "no_collab_for_cwd", ... }`:

> No collab found in this workspace. Run `whisper collab mount codex` in one terminal and `whisper collab mount claude` in another, then re-run this skill.

If `recovery.state === "recovery_required"`:

> The collab is in recovery_required state. Run `whisper collab recover`, then re-run this skill.

If `recovery.state === "recovered"`:

> The collab has been recovered and still needs reconnect. Run `whisper collab reconnect codex` and `whisper collab reconnect claude`, then re-run this skill.

If one agent's `bindingState` is anything but `"bound"`:

> <Agent> is not mounted (current bindingState: `<state>`). Run `whisper collab mount <agent>` in a separate terminal, then re-run this skill.

(Do NOT append permission flags — mount already spawns the agent in full-permission mode; passing `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` again can crash the agent on a duplicate-argument error.)

### 3. Kick off the workflow

Run:

```bash
whisper workflow start --type=spec-driven-development --spec=<resolved-absolute-path>
```

(No `--implementer` / `--reviewer` — the CLI fills SDD defaults: implementer=claude, reviewer=codex.)

Parse the workflowId from stdout (format: `Workflow started: <workflowId>`).

### 4. Report and exit

Print exactly:

> Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

Then stop. Do NOT poll `whisper workflow inspect`. Do NOT continue narrating. The workflow runs in the broker driver; your job is done.

## Why fire-and-forget

The broker's relay handoff system uses **idle detection** to know when an agent is ready to receive the next handoff. If this skill polled the workflow's status every few seconds, the calling agent (you) would emit output continuously, the broker would never see you as idle, and the workflow's first handoff couldn't be delivered to you — the workflow stalls. Kick off and exit; observation belongs to the dashboard.

## Resume / cancel

If the user asks to resume a halted workflow, run:

```bash
whisper workflow resume <workflowId>
```

If they ask to cancel:

```bash
whisper workflow cancel <workflowId>
```

Same fire-and-forget shape: invoke, report one line, exit.
