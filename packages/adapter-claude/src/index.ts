export const adapterClaudePackage = {
	name: "@ai-whisper/adapter-claude",
} as const;

export { createClaudeProvider } from "./create-claude-provider.js";
export { createClaudeLiveSession } from "./create-claude-live-session.js";
export type { ClaudeCommandConfig } from "./claude-command.js";
