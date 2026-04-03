import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createSessionId } from "@ai-whisper/shared";
import { createCliCollabId, createCliSessionId } from "../../runtime/id-factory.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { writeCliCollabState } from "../../runtime/state-file.js";

export async function runCollabStart(input: {
  workspaceRoot: string;
  now: string;
  launchMode: "tmux" | "terminals";
}) {
  const sqlitePath = getBrokerSqlitePath(input.workspaceRoot);
  mkdirSync(dirname(sqlitePath), { recursive: true });

  const broker = createBrokerRuntime({
    sqlitePath,
    host: "127.0.0.1",
    port: 4311,
  });

  const collabId = createCliCollabId(input.now);

  broker.control.startCollab({
    collabId,
    workspaceRoot: input.workspaceRoot,
    displayName: "phase5",
    now: input.now,
  });

  const codexSessionId = createSessionId(createCliSessionId("codex", input.now));
  const claudeSessionId = createSessionId(createCliSessionId("claude", input.now));

  broker.control.registerSession({
    sessionId: codexSessionId,
    collabId,
    agentType: "codex",
    capabilities: { supportsDirectPackets: true },
    now: input.now,
  });

  broker.control.registerSession({
    sessionId: claudeSessionId,
    collabId,
    agentType: "claude",
    capabilities: { supportsDirectPackets: true },
    now: input.now,
  });

  writeCliCollabState(getStateFilePath(input.workspaceRoot), {
    version: 1,
    collabId,
    workspaceRoot: input.workspaceRoot,
    broker: {
      sqlitePath,
      host: "127.0.0.1",
      port: 4311,
    },
    sessions: {
      codex: {
        sessionId: codexSessionId,
        providerId: "openai-codex-cli",
        launchMode: input.launchMode,
      },
      claude: {
        sessionId: claudeSessionId,
        providerId: "anthropic-claude-cli",
        launchMode: input.launchMode,
      },
    },
    startedAt: input.now,
  });

  await broker.stop();
}
