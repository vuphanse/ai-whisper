# Changelog

All notable changes to the `ai-whisper` package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-05-25

### Fixed

- **Stranded autonomous runs from duplicate active collabs.** A single workspace
  could accumulate more than one `active` collab; a workflow would then bind to
  one collab while the live mounted agents and the running daemon belonged to
  another, so its first handoff was created but never delivered or evaluated —
  the run hung forever at its first step while every operator surface
  (`status`, `inspect`, dashboard) reported "healthy". `ai-whisper` now enforces
  **one active collab per workspace** as an invariant: `mount` transparently
  re-adopts the existing active collab — including re-adopting one whose daemon
  has died, via `recover` — instead of creating a duplicate; a partial unique
  index makes the invariant impossible to violate from any code path; and a
  migration dedups any pre-existing duplicate active collabs (by survivor rules)
  before the index is created, re-run on every `applyMigrations`.
- **Clipboard capture race across concurrent collabs.** The relay captures an
  agent's handback by injecting `/copy` and reading the macOS system clipboard;
  with multiple collabs (or a human ⌘C) active on one host, a collab could read
  *another* collab's response and deliver it into the wrong workflow — worsened
  by the ≥100-char fast-path that trusts any substantial clipboard without a
  similarity check. A new **host-global capture lease** (a singleton row in the
  shared SQLite DB) now serializes every `/copy`→read window cross-process, so
  each read is provably this collab's own output. The lease reclaims stale
  holders (dead pid / TTL), releases on disconnect, and is swept on broker
  startup. `classifyCapture` and its load-bearing ≥100-char fast-path are
  unchanged — the lease removes the race that made the fast-path unsafe.

### Added

- **`changeCount` interference check** for the held capture window: snapshots
  `NSPasteboard.changeCount` before and after `/copy` (via a tiny `swiftc`-built
  native helper) to catch a human ⌘C that the lease cannot serialize. On
  interference it runs a bounded ladder — re-capture under the still-held lease
  → accept only on content similarity/identity (bypassing the ≥100-char
  fast-path) → degrade to the PTY turn text — and never blocks the turn. The
  helper degrades to a skipped check when unavailable (non-macOS or build
  failure), so capture still proceeds on the lease alone.
- `interference_detected` flag on relay capture diagnostics, recording when a
  foreign clipboard write was detected during a held capture window.

## [0.2.0] - 2026-05-25

### Added

- **`complex-bug-fixing` workflow** — a third bundled workflow alongside
  `spec-driven-development` and `ralph-loop`. A fixed three-phase pipeline for a
  reported bug whose root cause is unknown: **diagnosis → fix-and-verify →
  post-mortem**.
  - **Diagnosis** is guarded by a dedicated adversarial review protocol
    (`WORKFLOW_DIAGNOSIS_PROTOCOL`): the implementer must reproduce the bug
    themselves (a committed RED test is strongly preferred — speculation from
    reading code is not a valid reproduction), and the reviewer independently
    reproduces it and keeps the gate shut until both agree the cause is proven
    and the fix is net-safe.
  - **Fix-and-verify** turns the reproduction GREEN and verifies across the
    declared blast radius under an acceptance review that also checks
    test-coverage adequacy.
  - **Post-mortem** records confirmed cause, fix, coverage gaps, residual risks,
    and lessons learned.
  - Diagnosis and post-mortem artifacts live in a gitignored per-run dir
    (`.ai-whisper/bugfix/<workflowId>/`) and are not committed — only the fix and
    the reproduction test land in the repo.
- **`/aiw-bugfix <path>` kickoff skill** — fire-and-forget wrapper that starts
  `complex-bug-fixing` on a bug report after a collab-readiness check, mirroring
  `/aiw-sdd` and `/aiw-ralph`.
- Documentation for the new workflow in `docs/workflows.md` (at-a-glance entry,
  "choosing the workflow", and an "authoring a bug report" guide) and an updated
  bundled-workflows list in `docs/evaluator-configuration.md`.

### Changed

- Engine: added an opt-in `PhaseConfig.anchorCommitBaseOnEntry` flag so a
  review-loop phase can anchor the commit base on entry. This lets the
  fix-and-verify acceptance review resolve `{commitRange}` as `base..HEAD`,
  spanning both the phase-1 RED reproduction test commit and the phase-2 fix
  commits. The change is strictly additive — `spec-driven-development` and
  `ralph-loop` commit-range resolution is unchanged, guarded by regression
  tests.

## [0.1.4] - 2026-05-24

### Added

- `-v` / `--version` flag for the CLI, with a best-effort notice when a newer
  version is available.

### Changed

- Docs: README prerequisites, safety/permissions, and a "what happens if it
  fails" section; the two-agent non-goal codified in the concepts doc.
- Packaging: declare `engines.node >= 22` and add npm keywords.

## [0.1.3] - 2026-05-24

### Fixed

- Dashboard: clear on wall↔inspector switch (no duplicated frames), keep
  recently finished workflows visible (floor of 3), and stop rendering done
  workflows as stuck.

## [0.1.2] - 2026-05-24

### Added

- Caller-becomes-implementer role resolution and the workflows guide.

### Fixed

- Relay-handoff documentation correction.

## [0.1.1] - 2026-05-24

### Fixed

- Ship `README`, `LICENSE`, and `NOTICE` inside the published package. They live
  at the repo root but the package publishes from `packages/cli`, so npm
  previously showed no README and the tarball carried no license; a build step
  now copies them into `packages/cli`.

## [0.1.0] - 2026-05-24

### Added

- Initial public release: terminal-first relay for paired AI coding agents
  (Claude + Codex) driven by structured workflows, with npm metadata
  (description, repository, homepage).

[0.2.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.2.1
[0.2.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.2.0
[0.1.4]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.4
[0.1.3]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.3
[0.1.2]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.2
[0.1.1]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.1
[0.1.0]: https://github.com/ai-creed/ai-whisper/releases/tag/v0.1.0
