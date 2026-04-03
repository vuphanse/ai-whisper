import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";
import { listSessionsForCollab } from "../packages/broker/src/storage/repositories/session-repository.ts";
import { getWorkItem } from "../packages/broker/src/storage/repositories/work-item-repository.ts";

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "ai-whisper-fixes-"));
  return createBrokerRuntime({
    sqlitePath: join(dir, "broker.sqlite"),
    host: "127.0.0.1",
    port: 4311,
  });
}

/** Sets up a collab with two sessions, a thread, a work item (delivered), ready for postReply */
function setupFullFlow(runtime: ReturnType<typeof makeRuntime>) {
  const collab = runtime.control.startCollab({
    collabId: "collab_test1",
    workspaceRoot: "/tmp/test",
    displayName: "test",
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
    threadId: "thread_test1",
    collabId: collab.collabId,
    title: "Test thread",
    createdBySessionId: "session_claude_1",
    now: "2026-04-03T00:00:03.000Z",
  });

  const workItem = runtime.control.enqueueWorkItem({
    workItemId: "work_test1",
    threadId: thread.threadId,
    collabId: collab.collabId,
    senderSessionId: "session_claude_1",
    targetSessionId: "session_codex_1",
    requestedAction: "review_plan",
    instruction: "Review this.",
    contextPacket: {
      kind: "full",
      goal: "Test",
      currentState: "Testing",
      decisionsMade: [],
      assumptions: [],
      relevantArtifacts: [],
      openQuestions: [],
      successCriteria: [],
    },
    artifactManifestIds: [],
    now: "2026-04-03T00:00:04.000Z",
  });

  runtime.control.ackWorkItemDelivered({
    workItemId: workItem.workItemId,
    deliveredAt: "2026-04-03T00:00:05.000Z",
  });

  return { collab, thread, workItem };
}

describe("control service bug fixes", () => {
  let runtime: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    runtime = makeRuntime();
  });

  it("finding 1: registerSession with non-existent collab leaves no orphan session row", () => {
    expect(() =>
      runtime.control.registerSession({
        sessionId: "session_orphan_1",
        collabId: "collab_missing",
        agentType: "claude",
        capabilities: {},
        now: "2026-04-03T00:00:00.000Z",
      }),
    ).toThrow("Unknown collab: collab_missing");

    // The session row must NOT exist after the error
    const rows = listSessionsForCollab(runtime.db, "collab_missing");
    expect(rows).toHaveLength(0);
  });

  it("finding 2: postReply rejects a non-existent workItemId", () => {
    const { thread, collab } = setupFullFlow(runtime);

    expect(() =>
      runtime.control.postReply({
        replyId: "reply_bad1",
        threadId: thread.threadId,
        collabId: collab.collabId,
        workItemId: "work_missing",
        sourceSessionId: "session_codex_1",
        kind: "review",
        content: "Some review",
        transitionIntent: null,
        artifactManifestIds: [],
        now: "2026-04-03T00:00:06.000Z",
      }),
    ).toThrow();
  });

  it("finding 2: postReply rejects workItemId that belongs to a different thread", () => {
    const { collab, workItem } = setupFullFlow(runtime);

    // Create a second thread
    const thread2 = runtime.control.createThread({
      threadId: "thread_test2",
      collabId: collab.collabId,
      title: "Second thread",
      createdBySessionId: "session_claude_1",
      now: "2026-04-03T00:00:06.000Z",
    });

    // Try to post a reply on thread2 referencing workItem from thread1
    expect(() =>
      runtime.control.postReply({
        replyId: "reply_bad2",
        threadId: thread2.threadId,
        collabId: collab.collabId,
        workItemId: workItem.workItemId,
        sourceSessionId: "session_codex_1",
        kind: "review",
        content: "Cross-thread reply",
        transitionIntent: null,
        artifactManifestIds: [],
        now: "2026-04-03T00:00:07.000Z",
      }),
    ).toThrow();
  });

  it("finding 3: postReply with completed transition marks work item as completed", () => {
    const { thread, collab, workItem } = setupFullFlow(runtime);

    runtime.control.postReply({
      replyId: "reply_done1",
      threadId: thread.threadId,
      collabId: collab.collabId,
      workItemId: workItem.workItemId,
      sourceSessionId: "session_codex_1",
      kind: "answer",
      content: "Done.",
      transitionIntent: "completed",
      artifactManifestIds: [],
      now: "2026-04-03T00:00:06.000Z",
    });

    const updated = getWorkItem(runtime.db, workItem.workItemId);
    expect(updated?.deliveryState).toBe("completed");
    expect(updated?.completedAt).toBe("2026-04-03T00:00:06.000Z");
  });

  it("finding 3: postReply with failed transition marks work item as failed", () => {
    const { thread, collab, workItem } = setupFullFlow(runtime);

    runtime.control.postReply({
      replyId: "reply_fail1",
      threadId: thread.threadId,
      collabId: collab.collabId,
      workItemId: workItem.workItemId,
      sourceSessionId: "session_codex_1",
      kind: "failure",
      content: "Cannot proceed.",
      transitionIntent: "failed",
      artifactManifestIds: [],
      now: "2026-04-03T00:00:06.000Z",
    });

    const updated = getWorkItem(runtime.db, workItem.workItemId);
    expect(updated?.deliveryState).toBe("failed");
    expect(updated?.completedAt).toBe("2026-04-03T00:00:06.000Z");
  });

  it("finding 3b: postReply with awaiting_user transition still marks work item as completed", () => {
    const { thread, collab, workItem } = setupFullFlow(runtime);

    runtime.control.postReply({
      replyId: "reply_review1",
      threadId: thread.threadId,
      collabId: collab.collabId,
      workItemId: workItem.workItemId,
      sourceSessionId: "session_codex_1",
      kind: "review",
      content: "Needs user input.",
      transitionIntent: "awaiting_user",
      artifactManifestIds: [],
      now: "2026-04-03T00:00:06.000Z",
    });

    const updated = getWorkItem(runtime.db, workItem.workItemId);
    expect(updated?.deliveryState).toBe("completed");
    expect(updated?.completedAt).toBe("2026-04-03T00:00:06.000Z");
  });

  it("finding 3c: postReply with null transitionIntent still marks work item as completed", () => {
    const { thread, collab, workItem } = setupFullFlow(runtime);

    runtime.control.postReply({
      replyId: "reply_partial1",
      threadId: thread.threadId,
      collabId: collab.collabId,
      workItemId: workItem.workItemId,
      sourceSessionId: "session_codex_1",
      kind: "answer",
      content: "Partial update.",
      transitionIntent: null,
      artifactManifestIds: [],
      now: "2026-04-03T00:00:06.000Z",
    });

    const updated = getWorkItem(runtime.db, workItem.workItemId);
    expect(updated?.deliveryState).toBe("completed");
    expect(updated?.completedAt).toBe("2026-04-03T00:00:06.000Z");
  });

  it("finding 4: createThread with duplicate threadId does not deactivate existing threads", () => {
    const { collab, thread } = setupFullFlow(runtime);

    // Verify the original thread is active
    expect(runtime.control.getThread(thread.threadId)?.active).toBe(true);

    // Attempt to create a thread with the same ID — should fail
    expect(() =>
      runtime.control.createThread({
        threadId: thread.threadId, // duplicate
        collabId: collab.collabId,
        title: "Duplicate",
        createdBySessionId: "session_claude_1",
        now: "2026-04-03T00:00:10.000Z",
      }),
    ).toThrow();

    // Original thread must still be active
    expect(runtime.control.getThread(thread.threadId)?.active).toBe(true);
  });
});
