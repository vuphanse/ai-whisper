import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";

describe("broker companion registration", () => {
  it("registers a companion session and exposes queued work for that session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase4-broker-"));
    const runtime = createBrokerRuntime({
      sqlitePath: join(dir, "broker.sqlite"),
      host: "127.0.0.1",
      port: 4312,
    });

    const collab = runtime.control.startCollab({
      collabId: "collab_phase4",
      workspaceRoot: "/tmp/ai-whisper",
      displayName: "phase4",
      now: "2026-04-03T00:00:00.000Z",
    });

    runtime.control.registerSession({
      sessionId: "session_claude_1",
      collabId: collab.collabId,
      agentType: "claude",
      capabilities: { supportsDirectPackets: true },
      now: "2026-04-03T00:00:01.000Z",
    });

    runtime.control.registerSession({
      sessionId: "session_codex_1",
      collabId: collab.collabId,
      agentType: "codex",
      capabilities: { supportsDirectPackets: true },
      now: "2026-04-03T00:00:02.000Z",
    });

    const thread = runtime.control.createThread({
      threadId: "thread_phase4",
      collabId: collab.collabId,
      title: "Review architecture",
      createdBySessionId: "session_claude_1",
      now: "2026-04-03T00:00:03.000Z",
    });

    runtime.control.enqueueWorkItem({
      workItemId: "work_phase4",
      threadId: thread.threadId,
      collabId: collab.collabId,
      senderSessionId: "session_claude_1",
      targetSessionId: "session_codex_1",
      requestedAction: "review_plan",
      instruction: "Review the approved plan.",
      contextPacket: {
        kind: "full",
        goal: "Review the plan",
        currentState: "Approved",
        decisionsMade: [],
        assumptions: [],
        relevantArtifacts: [],
        openQuestions: [],
        successCriteria: [],
      },
      artifactManifestIds: [],
      now: "2026-04-03T00:00:04.000Z",
    });

    const registration = runtime.control.registerCompanion({
      collabId: collab.collabId,
      sessionId: "session_codex_1",
      provider: {
        providerId: "mock-provider",
        toolFamily: "mock-agent",
        providerVersion: "1.0.0",
      },
      capabilities: {
        supportsDirectPackets: true,
        supportsNormalization: false,
        supportsRelayInterception: false,
        supportsLocalBuffering: false,
        supportsLaunchHooks: false,
        extensions: {},
      },
      now: "2026-04-03T00:00:05.000Z",
    });

    expect(registration.sessionSecret.length).toBeGreaterThan(15);
    expect(
      runtime.control.pollQueuedWorkItem({
        collabId: collab.collabId,
        sessionId: "session_codex_1",
        sessionSecret: registration.sessionSecret,
      })?.workItemId,
    ).toBe("work_phase4");

    await runtime.stop();
  });
});
