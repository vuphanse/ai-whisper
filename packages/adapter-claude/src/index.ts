export const adapterClaudePackage = {
	name: "@ai-whisper/adapter-claude",
} as const;

export { createClaudeProvider } from "./create-claude-provider.js";
export { createClaudeLiveSession } from "./create-claude-live-session.js";
export { createClaudeAttachedSession } from "./create-claude-attached-session.js";
export { buildClaudeFileBackedBrokerPrompt, buildClaudePrompt } from "./claude-prompt.js";
export type { ClaudeCommandConfig } from "./claude-command.js";
