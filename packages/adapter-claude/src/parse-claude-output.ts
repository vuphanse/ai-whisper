import { mockProviderReplySchema, type MockProviderReply } from "@ai-whisper/shared";

export function parseClaudeOutput(stdout: string): MockProviderReply {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    return {
      kind: "failure",
      content: "Provider output did not contain JSON",
      transitionIntent: "failed",
    };
  }

  try {
    return mockProviderReplySchema.parse(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return {
      kind: "failure",
      content: "Provider output contained invalid JSON",
      transitionIntent: "failed",
    };
  }
}
