# Evaluator Configuration + Preflight — Design

## Goal

Give users a robust, persistent, shell-independent way to configure the relay evaluator (the LLM that judges each workflow handoff), modeled on codex's `~/.codex/auth.json` + `config.toml` split — then preflight that configuration so a missing/invalid setup is reported at skill-invocation and workflow-kickoff time, not 80 seconds into a halted workflow.

## Motivation

Smoke testing the SDD flow surfaced this: the workflow kicked off, ran spec-refining, then **halted** with a cryptic `LLM evaluation failed after retry`. The buried cause: the evaluator's Anthropic client had no credentials. Two root problems:

1. **Config is undocumented env-var guesswork captured at daemon startup.** `packages/cli/src/bin/broker-daemon.ts` reads raw `process.env`:
   - `ANTHROPIC_API_KEY` (the `!` non-null assertion lies — unset → the client throws at first call)
   - `AI_WHISPER_EVALUATOR_PROVIDER` (`anthropic` | `ollama`, default `anthropic`)
   - `AI_WHISPER_EVALUATOR_FALLBACK` (`anthropic` | `ollama` | unset)
   - `AI_WHISPER_EVALUATOR_OLLAMA_HOST`, `AI_WHISPER_EVALUATOR_OLLAMA_MODEL`

   None documented, none validated, no anthropic-model knob, and — critically — the daemon only sees a key if it was exported in **the exact shell that ran `whisper collab mount`**. Run mount from a shell without the key and the evaluator silently can't authenticate.

2. **No preflight.** Nothing checks the evaluator is usable before a workflow starts, so misconfiguration manifests as a slow, opaque mid-workflow halt.

## Non-goals

- Migrating away from the Anthropic SDK or changing the evaluator's prompt/verdict logic.
- Per-collab or per-workspace evaluator config — config is global to the user (one evaluator setup), like codex's.
- Hot-reload of config into a running daemon. The daemon reads config at startup; changing it requires a daemon restart (`whisper collab stop` + re-mount). This is acceptable because the config now **persists** (set once in a file), versus today's per-shell env vars.
- OS-keychain secret storage. Secrets live in `auth.json` (mode `600`), exactly as codex stores them in `~/.codex/auth.json`.
- A general-purpose `whisper config set/get` editor command. Out of scope here; users edit the JSON files directly (documented). A read-only `whisper doctor`-style validator is folded into Phase 2's preflight surfacing, not a full editor.

## Phase 1 — Evaluator configuration layer

### 1.1 Files

All under `getStateRoot()` (default `~/.ai-whisper/`, honoring the `AI_WHISPER_STATE_ROOT` override so tests and isolation work). This is the same root that holds `state.db`.

**`auth.json`** (secrets; created/expected at mode `600`, mirroring codex):

```json
{ "ANTHROPIC_API_KEY": "sk-ant-..." }
```

The key name is the literal `ANTHROPIC_API_KEY` (mirrors codex's `OPENAI_API_KEY`-style key in `auth.json`).

**`config.json`** (non-secret settings):

```json
{
  "evaluator": {
    "provider": "anthropic",
    "fallback": "ollama",
    "anthropicModel": "claude-3-5-sonnet-latest",
    "ollama": { "host": "http://localhost:11434", "model": "llama3.1" }
  }
}
```

All `evaluator` fields are optional; absent fields fall back to built-in defaults (provider=anthropic, no fallback, the evaluator's current default anthropic model, ollama defaults).

**`.env`** (optional dotenv) at `~/.ai-whisper/.env` — supports the existing `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*` variables for users who prefer env style. Loaded by the config layer, not by the shell.

### 1.2 Precedence

Highest → lowest, per resolved value:

1. **Exported process env var** (e.g., `ANTHROPIC_API_KEY` already in the daemon's environment)
2. **`~/.ai-whisper/.env`** entries
3. **`auth.json`** (secrets) / **`config.json`** (settings)
4. **Built-in defaults**

Rationale: existing env-var users are unaffected (env still wins, preserving current behavior); the files are the persistent, shell-independent fallback. `.env` sits between explicit env and the JSON files so a project/user `.env` can override the committed-ish JSON without exporting in every shell.

**The workspace `.env` must not reach the daemon — two leak paths, both closed.** A workspace `.env` is a workdir-dependent config source, exactly what this design eliminates, and it currently reaches the daemon two ways:
1. **Daemon-side:** `broker-daemon.ts:18` calls `loadDotEnv()` (`packages/cli/src/runtime/load-dot-env.ts`, which runs `process.loadEnvFile()` against the **current working directory** — the workspace the daemon was spawned in). Remove this call so the daemon's config comes only from (a) the explicit env `buildBrokerDaemonEnv` injects, (b) the fixed `~/.ai-whisper/.env`, and (c) the fixed JSON files.
2. **Inherited via spawn:** the CLI entry's `loadDotEnv()` (`whisper.ts:5`) loads the workspace `.env` into the CLI's `process.env` before any command runs, and `buildBrokerDaemonEnv` (`runtime/broker-daemon.ts`) spreads `...process.env` into the spawned daemon — so removing only path 1 is insufficient. Close this by spawning the daemon with a **pristine env snapshot** captured at module-load time (before `whisper.ts`'s body runs `loadDotEnv()`): the daemon inherits the real shell env (PATH, HOME, a genuinely-exported `ANTHROPIC_API_KEY`) but NOT workspace-`.env` additions. `whisper.ts`'s `loadDotEnv()` itself is unchanged — interactive CLI commands keep their workspace-`.env` behavior; only the daemon spawn is shielded.

Migration note for the README: anyone who relied on a workspace `.env` to feed the daemon's `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*` moves it to `~/.ai-whisper/auth.json` / `config.json` / `.env`.

### 1.3 The loader

A new `loadEvaluatorConfig()` in `packages/cli/src/runtime/evaluator-config.ts` (the daemon + evaluator both live in the cli package). It:

1. Reads `~/.ai-whisper/.env` (if present) via a **minimal KEY=VALUE parser** — no new dependency. Handles `KEY=value`, `#` comments, blank lines, and surrounding single/double quotes on the value. Does NOT implement full dotenv escaping/interpolation (documented limitation); anything fancier, users can export real env vars (highest precedence). Parsed entries are applied only where the real `process.env` does not already define the key (env wins).
2. Reads `auth.json` + `config.json` (if present); tolerates missing files (returns partial config) but reports a clear error on malformed JSON (don't silently ignore a typo'd config).
3. Resolves each value by precedence and returns a typed result:

```ts
interface ResolvedEvaluatorConfig {
  provider: "anthropic" | "ollama";
  fallback: "anthropic" | "ollama" | null;
  anthropic: { apiKey: string | null; model: string | null };
  ollama: { host: string | null; model: string | null };
}
```

`apiKey: null` is a first-class "not configured" signal (no more `!` lie) — Phase 2's preflight keys off it.

### 1.4 Daemon integration

`broker-daemon.ts`'s `buildProviderConfig` + the `evaluator` IIFE stop reading raw `process.env` and instead consume `loadEvaluatorConfig()`. Behavior is identical when the existing env vars are set (they remain highest precedence), so this is a backward-compatible refactor plus the new file sources.

The daemon reads config at startup from the fixed `getStateRoot()` location — so it no longer matters which shell spawned it. This is the core robustness win.

## Phase 2 — Preflight (after the config layer lands)

Two checkpoints, both keyed off the resolved config (per the earlier "Spot A / Spot B" framing):

### 2.1 Daemon records evaluator readiness

At startup, the daemon calls `loadEvaluatorConfig()` **inside a try/catch** (the loader throws on malformed `auth.json`/`config.json`). It then computes readiness and persists `broker_daemon.evaluator_status` (new `TEXT` column, nullable):

- loader threw (malformed JSON / unreadable config) → `"invalid_config"` — the daemon catches the error, records this status (capturing the message for the remediation), runs with `evaluator = null`, and **stays up** so preflight can surface it. It must NOT crash here: a daemon that dies before writing `evaluator_status` would make `mount`/`start` hit the generic broker-readiness timeout instead of the actionable message.
- orchestrator disabled → `"disabled"` (workflows can't run anyway; not the evaluator's fault)
- provider `anthropic` and `anthropic.apiKey` is null → `"missing_anthropic_key"`
- provider `ollama` → `"ready"` (host assumed reachable; a live ping is out of scope — a bad host surfaces as `provider_unavailable` at call time, which the existing diagnostics already capture)
- otherwise → `"ready"`

**Separation of concerns:** the loader is a pure function that throws a clear `Invalid <file>: <json error>` (easy to unit-test); the DAEMON is responsible for catching it and degrading gracefully into `invalid_config` + a live broker. The daemon is the authority because it holds the resolved config; the CLI process that runs `workflow start` does not share its environment.

### 2.2 `collab status --json` surfaces it

Add an `evaluator` field to the readiness JSON:

```json
"evaluator": { "ready": true, "status": "ready" }
```

`status` is the daemon's `broker_daemon.evaluator_status`, mapped to `"unknown"` when the column is null (older daemon predating the migration). **`ready` is `status === "ready" || status === "unknown"`** — i.e., only an explicit non-ready status (`missing_anthropic_key`, `invalid_config`) reports `ready: false`. `unknown` is treated as ready so pre-migration daemons aren't false-alarmed. This lets the SDD skill preflight (Spot A).

### 2.3 SDD skill readiness gate (Spot A)

The `ai-whisper-sdd` SKILL.md readiness section adds: if `evaluator.ready === false`, bail BEFORE `workflow start`. The message branches on `status`:

- `missing_anthropic_key` → *Set `ANTHROPIC_API_KEY` in `~/.ai-whisper/auth.json` (or your environment), then restart the daemon: `whisper collab stop` and re-mount.*
- `invalid_config` → *Your `~/.ai-whisper/auth.json` or `config.json` is malformed — fix the JSON, then restart the daemon (`whisper collab stop` + re-mount).*

Both point to the README "Evaluator configuration" section.

### 2.4 `workflow start` bail (Spot B — the safety net)

Before `createWorkflow`, `workflow start` reads the daemon's `evaluator_status` (via the resolved collab's daemon row). It bails (throws the matching remediation) on `missing_anthropic_key` and `invalid_config`; it proceeds on `ready`, `unknown` (older daemon — don't block), and `disabled` (the orchestrator-off case is rejected elsewhere by `createWorkflow`'s own orchestrator-enabled check, so no need to duplicate it here). Backstops anyone invoking the CLI directly without the skill.

## Documentation

A new README section, **"Evaluator configuration (required for workflows)"**:

- The bundled workflows (SDD; future ralph-loop) need a configured evaluator.
- Quickest setup: create `~/.ai-whisper/auth.json` with `{ "ANTHROPIC_API_KEY": "sk-ant-..." }` (mode `600`).
- Optional `~/.ai-whisper/config.json` `evaluator` block for provider/fallback/model/ollama.
- Optional `~/.ai-whisper/.env` for env-style config.
- Precedence + the restart-after-change note.
- Pointer: `whisper collab status --json` shows `evaluator.ready`.

## Architecture

Surfaces touched:

1. **New config loader** (`packages/cli/src/runtime/evaluator-config.ts`) + its `.env` mini-parser — Phase 1.
2. **Daemon** (`packages/cli/src/bin/broker-daemon.ts`) — consume the loader; compute + persist readiness — Phase 1 + 2.1.
3. **Schema** — `broker_daemon.evaluator_status` column (migration) + repo read/write — Phase 2.1.
4. **`collab status --json`** (`status.ts`) — `evaluator` field — Phase 2.2.
5. **SDD skill** (`packages/cli/skills/ai-whisper-sdd/SKILL.md`) — readiness gate — Phase 2.3.
6. **`workflow start`** (`commands/workflow/start.ts` or its caller) — preflight bail — Phase 2.4.
7. **README** — required-config section.

No change to the evaluator's prompt/verdict logic or the Anthropic SDK usage beyond sourcing `apiKey`/`model` from the resolved config.

## Data flow

```
daemon startup (broker-daemon.ts)
  → loadEvaluatorConfig()                    # .env + auth.json + config.json + process.env, by precedence
      → ResolvedEvaluatorConfig { provider, fallback, anthropic:{apiKey,model}, ollama:{host,model} }
  → buildProviderConfig() uses resolved values
  → compute evaluator_status, persist to broker_daemon row

skill invocation (/aiw-sdd)
  → whisper collab status --json
      → { …, evaluator: { ready, status } }
  → if !ready → bail with remediation (Spot A)

workflow start (skill or direct CLI)
  → resolve collab + daemon row
  → if daemon.evaluator_status in {missing_anthropic_key, invalid_config} → throw remediation (Spot B)
      (proceeds on ready / unknown / disabled)
  → else createWorkflow
```

## Error handling

- **Malformed `auth.json`/`config.json`** → the loader throws a clear `Invalid <file>: <json error>` (rather than silently falling through to "no key", which would mask a typo as a missing-key error). The DAEMON catches that throw at startup, records `evaluator_status = "invalid_config"`, and stays up (per 2.1) — so the failure reaches the user as the preflight remediation, never as a generic broker-readiness timeout.
- **Missing files** → not an error; the loader returns partial config and lower-precedence sources / defaults fill in.
- **`.env` parse** → best-effort line parser; unparseable lines are skipped with a warning, never throw (a stray line shouldn't brick startup).
- **`auth.json` perms** → if the file is group/world-readable, log a one-line warning recommending `chmod 600` (match codex's posture); do not refuse to read.
- **Older daemon without `evaluator_status`** → `status --json` reports `evaluator: { ready: true, status: "unknown" }` (null column → don't false-alarm); the `workflow start` bail only triggers on an explicit non-ready status, so pre-migration daemons aren't blocked.

## Testing rigor

**Phase 1 (loader):**
- Unit: precedence matrix — process.env beats `.env` beats `auth.json`/`config.json` beats defaults, per field.
- Unit: missing files → defaults; partial files → partial override.
- Unit: malformed JSON → throws with the filename; bad `.env` line → skipped, no throw.
- Unit: resolves `apiKey: null` when nothing supplies a key (drives the preflight).
- All against a temp `AI_WHISPER_STATE_ROOT`.

**Phase 2 (preflight):**
- Unit: daemon readiness computation — anthropic+key→ready, anthropic+no-key→missing_anthropic_key, ollama→ready, orchestrator-off→disabled, loader-throws→invalid_config (daemon catches, records, stays up).
- Unit: `collab status --json` includes `evaluator` with the documented shape; null column → `unknown`/ready.
- Unit: `workflow start` bails on `missing_anthropic_key` and `invalid_config` (distinct remediation messages); proceeds on `ready`, `unknown`, and `disabled` (orchestrator-off is rejected by createWorkflow's own check, not this bail).
- Integration: real broker against temp sqlite — seed a daemon row with `evaluator_status='missing_anthropic_key'`, assert `runWorkflowStart` rejects with the remediation message.
- No leaked broker daemons after the suite (stub daemon spawning, per the established pattern).

## Acceptance criteria

- Setting `~/.ai-whisper/auth.json` with `ANTHROPIC_API_KEY` makes the evaluator work in any subsequently-spawned daemon, regardless of which shell ran `mount`.
- Existing `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*` env vars continue to work unchanged (highest precedence).
- `whisper collab status --json` reports `evaluator.ready`.
- Invoking the SDD skill with no evaluator key bails immediately with the file-based remediation (not an 80s halt).
- `whisper workflow start` bails the same way when invoked directly.
- README documents the config files as required for workflows.
- Full suite green; no leaked daemons.

## Open questions

None as of design close (2026-05-21). Sequence is fixed: Phase 1 (config layer + docs) lands first, then Phase 2 (preflight at skill readiness + workflow kickoff).
