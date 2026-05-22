# ai-whisper-ralph skill — design

Date: 2026-05-22
Status: approved-for-planning

## Problem

The ralph-loop workflow engine shipped (registry def, control mapping, durable
`PROGRESS.md`/`LEARNINGS.md`, acceptance gate), but it is **CLI-only**: the only
way to start it is `whisper workflow start --type=ralph-loop --spec=<goal>`. The
spec-driven-development workflow, by contrast, has a bundled agent skill
(`ai-whisper-sdd`) that an agent invokes from chat ("run SDD on <path>"),
which verifies collab readiness, kicks off, and exits.

Ralph has no such skill, so the daily in-chat flow ("run ralph on this goal")
does not work. This spec defines `ai-whisper-ralph`, a near-clone of
`ai-whisper-sdd`, to close that gap.

## Goal

A bundled agent skill, `ai-whisper-ralph`, that an agent can invoke from chat to
start a ralph-loop workflow against an **existing goal file**, with the same
fire-and-forget shape as `ai-whisper-sdd`: verify readiness, kick off, report one
line, exit.

## Non-goals

- Authoring the goal file. v1 requires an existing, readable goal file; the skill
  does not draft one. (Open-ended goal authoring may come later.)
- A first-class procedure artifact. Per-chunk procedure/conventions (test-first,
  lint, commit format, definition-of-done) live **inside the goal file** in v1; a
  dedicated `PROCEDURE.md` referenced by the kickoff template would be an engine
  change and is a ralph phase-2 candidate, not part of this skill.
- Any change to the ralph-loop engine, control mapping, or evaluator. This is a
  skill (markdown) plus docs plus one guard test only.
- New CLI flags. `whisper workflow start --type=ralph-loop` already exists and
  fills role defaults (implementer=claude, reviewer=codex).

## Design

### File

`packages/cli/skills/ai-whisper-ralph/SKILL.md`.

Both the build-time copy (`packages/cli/scripts/copy-skills.mjs`, which copies the
whole `skills/` dir) and `whisper skill install` (which enumerates skill dirs via
`readdir`) auto-discover any new skill directory. **No edits to the copy script or
the install command are required** — dropping the new directory in is sufficient.

### Skill behavior (mirrors ai-whisper-sdd exactly except where noted)

Frontmatter:
- `name: ai-whisper-ralph`
- `description`: triggers on phrases like *"run ralph on \<goal\>"*, *"ralph loop
  on \<goal\>"*, *"kick off ralph with \<goal\>"*, */aiw-ralph \<goal\>* (Claude
  picker), *$aiw-ralph \<goal\>* (Codex picker).

Steps:

1. **Resolve the goal path.** The user names a path; strip a leading `@`; resolve
   to absolute; verify readable via the Read tool. If not readable, bail:
   > Goal file `<path>` is not readable. Check the path and try again.

   If the user references the goal ambiguously ("run ralph on the goal we
   discussed"), ask for the path ONCE; do not guess.

   Framing note in the skill: the file is an **open-ended goal / checklist** (e.g.
   `GOAL.md`), not a formal spec. The ralph loop reads it as ground truth and
   grinds toward it chunk-by-chunk. The skill should tell the user that any
   **per-chunk procedure / conventions** (test-first, lint, commit format,
   definition-of-done) belong in this goal file: the kickoff re-reads the goal
   every iteration, so embedded procedure persists across context resets and the
   implementer follows it on every chunk.

2. **Verify collab readiness.** Byte-for-byte the same `whisper collab status
   --json` gate as `ai-whisper-sdd`: `daemon !== null`, `status === "active"`,
   `recovery.state === "normal"`, BOTH agents `bindingState === "bound"`,
   `evaluator.status` not in `{missing_anthropic_key, invalid_config}`. Same
   remediation messages for each failure (no-collab, recovery_required, recovered,
   unbound agent, missing key, invalid config, disabled-passes-through). Do NOT
   append permission flags on remediation mount hints.

3. **Kick off.**
   ```bash
   whisper workflow start --type=ralph-loop --spec=<resolved-absolute-goal-path>
   ```
   (No `--implementer` / `--reviewer`; the CLI fills ralph defaults
   implementer=claude, reviewer=codex.) Parse the workflowId from
   `Workflow started: <workflowId>`.

4. **Report and exit.** Print exactly:
   > Workflow `<workflowId>` started. Track progress with `whisper collab dashboard`.

   Then stop. Do NOT poll `whisper workflow inspect`; do NOT narrate. The same
   idle-detection rationale as SDD applies: continuous output from the calling
   agent blocks the broker's idle detection and stalls the first handoff.

5. **What ralph does (short orientation block).** One paragraph: ralph loops
   chunk-by-chunk against the goal, each chunk reviewed; when the implementer
   claims the whole goal is done, an acceptance review gates completion.
   `PROGRESS.md` and `LEARNINGS.md` under `.ai-whisper/ralph/<workflowId>/` are its
   durable memory; per-item auto-commits land the work. The dashboard is the
   inspection surface.

6. **Resume / cancel.** Same as SDD: `whisper workflow resume <id>` /
   `whisper workflow cancel <id>`, fire-and-forget (one line, exit).

### Differences from ai-whisper-sdd (exhaustive)

1. Frontmatter `name`/`description` (ralph trigger phrases).
2. "Goal file / checklist" framing instead of "spec file".
3. `--type=ralph-loop` instead of `--type=spec-driven-development`.
4. The short "what ralph does" orientation block (SDD has no equivalent; helps the
   invoking agent set user expectations about the looping behavior).

Everything else — the readiness gate, the fire-and-forget rationale, the
report-and-exit line, resume/cancel — is identical.

### Docs

README: update the daily-flow and "Required skills" sections so they reference
both bundled skills. Specifically:
- The daily-flow section currently shows only `ai-whisper-sdd`; add a parallel
  mention that ralph-loop is started with `ai-whisper-ralph` ("run ralph on
  \<goal\>").
- The "Required skills" sentence "This copies `ai-whisper-sdd` (and any future
  bundled skills)" becomes "This copies `ai-whisper-sdd` and `ai-whisper-ralph`".

### Test

One cheap guard test (no existing skill-test harness, so add a minimal one):
- After build, the bundled skills directory contains `ai-whisper-ralph` with a
  `SKILL.md`, and that `SKILL.md` text contains `--type=ralph-loop`.
- Assert `whisper skill install` (or its enumeration) would include
  `ai-whisper-ralph` — i.e. the auto-discovery picks it up alongside
  `ai-whisper-sdd`.

This guards against the skill silently failing to ship (wrong dir name, missing
file) or pinning the wrong workflow type. It does not test prose quality — that is
covered by review.

## Acceptance criteria

1. `packages/cli/skills/ai-whisper-ralph/SKILL.md` exists with the four documented
   differences and otherwise mirrors `ai-whisper-sdd`.
2. The skill kicks off with `--type=ralph-loop` and the resolved absolute goal
   path; reports exactly one line; instructs no polling.
3. The readiness gate matches `ai-whisper-sdd` (same checks, same remediation
   messages).
4. `whisper skill install` installs `ai-whisper-ralph` into both
   `~/.claude/skills/` and `~/.codex/skills/` with no code changes to the install
   command (auto-discovery).
5. README references both skills in the daily-flow and Required-skills sections.
6. The guard test passes; full suite + typecheck + lint + build stay green.

## Risks / edge cases

- **Goal file not readable / ambiguous** → covered by step 1 (bail / ask once).
- **Evaluator `disabled`** → passes the skill gate (matches SDD); `workflow start`
  surfaces the orchestrator-disabled error itself.
- **New skill not picked up by build** → guard test catches it.
- **Wrong workflow type string** → guard test asserts `--type=ralph-loop`.
- **Permission-flag duplication on mount hints** → skill repeats the SDD warning
  not to append `--dangerously-*` flags.
