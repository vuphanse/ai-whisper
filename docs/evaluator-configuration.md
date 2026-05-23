# Evaluator configuration (required for workflows)

The bundled workflows (`spec-driven-development`, `ralph-loop`) use an LLM **evaluator** to judge each handoff. The evaluator requires credentials. Without them, a workflow bails at kickoff with a remediation message — both the kickoff skills and `whisper workflow start` refuse to start rather than halting partway into a run. So this is required setup before running any workflow.

Configuration lives in `~/.ai-whisper/` (the same root as `state.db`), so it is set once and is independent of which shell spawned the daemon.

## Quick setup (Anthropic)

Create `~/.ai-whisper/auth.json` with your API key, then lock it down:

```bash
mkdir -p ~/.ai-whisper
cat > ~/.ai-whisper/auth.json <<'JSON'
{ "ANTHROPIC_API_KEY": "sk-ant-..." }
JSON
chmod 600 ~/.ai-whisper/auth.json
```

That is enough to run the workflows with the default Anthropic provider.

## Optional settings (`config.json`)

Non-secret evaluator settings go in `~/.ai-whisper/config.json`. All fields are optional and fall back to built-in defaults:

```json
{
  "evaluator": {
    "provider": "anthropic",
    "fallback": "ollama",
    "anthropicModel": "claude-sonnet-4-6",
    "ollama": { "host": "http://localhost:11434", "model": "qwen2.5:7b-instruct" }
  }
}
```

- `provider` — `"anthropic"` (default) or `"ollama"`.
- `fallback` — provider to retry once on a network/rate-limit error; omit for none.
- `anthropicModel` — overrides the evaluator's default Anthropic model.
- `ollama.host` / `ollama.model` — used when the provider or fallback is `ollama`.

If you choose the `ollama` provider you do not need an Anthropic key.

## Optional env-style file (`.env`)

For users who prefer env-style config, `~/.ai-whisper/.env` accepts the same `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*` variables. It is loaded by the config layer, not the shell. The parser is intentionally minimal: `KEY=VALUE` lines, `#` comments, blank lines, and surrounding single/double quotes — no interpolation or escaping. For anything fancier, export a real environment variable (highest precedence).

## Precedence

Per resolved value, highest to lowest:

1. Exported process environment variable
2. `~/.ai-whisper/.env`
3. `~/.ai-whisper/auth.json` (secrets) / `~/.ai-whisper/config.json` (settings)
4. Built-in defaults

Existing env-var users are unaffected — exported env vars still win.

## Restart after changing config

The daemon reads this configuration **once at startup**. After editing any of these files, restart the daemon for the change to take effect: `whisper collab stop`, then re-mount (or otherwise restart the broker).

## Migration from a workspace `.env`

The daemon no longer reads a workspace/cwd `.env`. If you previously relied on a project `.env` to feed the daemon's `ANTHROPIC_API_KEY` / `AI_WHISPER_EVALUATOR_*`, move those values into `~/.ai-whisper/auth.json`, `config.json`, or `.env`.

## Verify

```bash
whisper collab status --json
```

Check the `evaluator` field — `evaluator.ready` should be `true` and `evaluator.status` should be `"ready"`. A `false` reading reports the reason in `status` (e.g. `missing_anthropic_key` or `invalid_config`) so you know what to fix.
