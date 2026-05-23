# Goal: Rewrite ai-whisper README and Concepts Docs

## Context

This goal incorporates the rewrite guidance directly so the `ralph-loop` workflow can run from a single goal file. The current `README.md` is long, phase/history-heavy, and mixes quickstart, internals, operator details, recovery, evaluator configuration, hotkeys, and implementation history. The rewrite should make the project understandable quickly without losing routes to deeper documentation.

This is a documentation rewrite task intended for the `ralph-loop` workflow. Work chunk-by-chunk and keep each chunk independently reviewable.

## Source Material

Existing docs to preserve or route to:

- `README.md`
- `docs/relay-handoff-flows.md`
- `docs/legacy-attach.md`
- `docs/smoke-tests/`
- `docs/superpowers/specs/`

## Goal

Rewrite the public-facing documentation so a senior engineer can understand what ai-whisper is, decide whether it fits their workflow, and get a basic workflow running quickly.

The final deliverable should include:

1. A concise `README.md`.
2. A new or updated concepts document under `docs/` that explains the mental model in more depth.
3. Updated README smoke coverage that asserts the rewritten README's public contract.

## Required README Shape

The README should be concise and ordered roughly as:

1. One-paragraph explanation.
2. "Magic moment" quick example:
   - show mounting Claude and Codex. Use the actual current CLI syntax; if the guide's shorthand conflicts with implemented commands, preserve the intent but make the commands accurate:
     ```bash
     whisper collab mount claude
     whisper collab mount codex
     ```
   - then show starting a structured workflow from a spec:
     ```text
     Run spec-driven-development using docs/spec.md
     ```
   - briefly explain implementer/reviewer assignment, autonomous workflow execution, review loops, resumability, and deliverables.
3. Visual proof section:
   - prefer a real terminal screenshot or GIF if an appropriate asset already exists.
   - do not fabricate a screenshot.
   - if no asset exists, include a short placeholder section that clearly says a real terminal workflow screenshot/GIF should be added and describes what it should show.
4. "Who this is for":
   - for engineers already using coding agents heavily.
   - for terminal-first workflows.
   - for multi-agent review.
   - for long-running structured workflows.
   - not for one-shot vibe coding, invisible automation, or beginner workflows.
5. Minimal quickstart.
6. Brief core concepts with links to deeper docs.
7. Learn-more links.

The README must explain:

- terminal-native collaboration.
- coding-agent collaboration.
- structured workflows.
- resumable execution.
- Claude + Codex support today.
- provider-agnostic direction.

## Concepts Documentation Requirements

Create a strong mental model in a separate docs file, likely `docs/concepts.md` unless a better existing home is obvious.

It must explain:

- ai-whisper is not a swarm.
- agents do not type simultaneously.
- baton handoff means one owner at a time.
- mounted sessions are real provider sessions and are the source of truth.
- autonomy is inspectable and resumable.
- workflows are structured loops and state transitions.

The concepts doc can be longer than the README, but it should still be direct and operational.

## Move Out Of README

The README should not carry deep detail for:

- orchestrator internals.
- detailed lifecycle states.
- capture diagnostics.
- hotkeys.
- recovery internals.
- evaluator config.
- provider configuration.
- phase roadmap/history.
- exhaustive CLI reference.
- troubleshooting.

Keep or move these details into existing docs where reasonable. Prefer links over duplicating full explanations.

## Writing Style

Tone:

- engineering-focused.
- grounded.
- opinionated but calm.
- minimal hype.

Avoid:

- exaggerated claims.
- AGI language.
- "revolutionary" framing.
- vague buzzwords.

Prefer:

- concrete workflows.
- operational clarity.
- explicit tradeoffs.

Think: "tool written by an engineer for other engineers," not "AI startup landing page."

## Chunking Guidance For Ralph

Use this checklist as the initial `PROGRESS.md` plan:

1. Audit current README and docs links; decide the final README outline and concepts-doc path.
2. Rewrite the README introduction, magic moment, audience, and quickstart.
3. Move or link deep operational details out of the README while preserving discoverability.
4. Create or update the concepts documentation.
5. Update README smoke tests to match the new public contract.
6. Run verification and do a final self-review against this goal.

Each item should be small enough to complete, verify, and pass review independently. If a chunk fails review twice, split it.

## Per-Chunk Procedure

For each chunk:

1. Re-read this goal plus `PROGRESS.md` and `LEARNINGS.md`.
2. Make only the documentation/test changes needed for the current checklist item.
3. If changing README claims or commands, verify them against the current CLI/docs rather than copying stale wording.
4. Update `PROGRESS.md`.
5. Run the narrow relevant check for the chunk when practical.
6. Commit the accepted chunk.

Keep this lightweight. Do not turn every chunk into a full docs migration; preserve momentum by delivering one reviewable improvement at a time.

## Verification

`test/readme-smoke.test.ts` is expected to change. The current test asserts the old README shape and should not be treated as the final oracle after the rewrite.

Before final verification:

1. Update `test/readme-smoke.test.ts` so it asserts the new README contract from this goal: concise positioning, magic moment, audience fit/non-fit, quickstart, concepts links, and deeper-doc routing.
2. Then run:

```bash
pnpm test -- test/readme-smoke.test.ts
```

If tests are changed or if the rewrite touches package scripts or generated docs, also run the relevant broader checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Do not claim completion unless the relevant verification has run and the output is reported.

## Acceptance Criteria

The goal is complete when:

1. `README.md` is substantially shorter and no longer reads like phase history or internal architecture notes.
2. The first screen of the README tells a senior engineer what ai-whisper does and why they might use it.
3. The README contains the magic-moment example and explains implementer/reviewer assignment, autonomous workflow execution, review loops, resumability, and deliverables.
4. The README clearly states who the project is for and who it is not for.
5. The README has a minimal quickstart and links to deeper docs instead of embedding deep internals.
6. A concepts doc explains not-a-swarm, baton handoff, real mounted sessions, human-supervised autonomy, and workflow-first execution.
7. Existing important details remain discoverable through links or moved docs.
8. README smoke coverage is updated if needed and relevant verification passes.
9. The final handback summarizes changed files, verification run, and any visual-proof asset gap that still needs a real screenshot/GIF.

## Out Of Scope

- Do not redesign the CLI.
- Do not change runtime behavior.
- Do not rewrite every historical spec.
- Do not invent screenshots or GIFs.
- Do not add marketing claims that are not backed by current functionality.
