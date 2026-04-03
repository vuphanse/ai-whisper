import { createClaudeProvider } from "@ai-whisper/adapter-claude";
import { createCodexProvider } from "@ai-whisper/adapter-codex";

export function createProviderForTarget(target: "codex" | "claude") {
  if (target === "codex") {
    return createCodexProvider({
      executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
      execArgs: ["exec"],
    });
  }
  return createClaudeProvider({
    executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
    execArgs: ["-p"],
  });
}
