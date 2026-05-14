import { describe, expect, it, vi } from "vitest";
import { createMountedTurnOwnedRelay } from "../packages/cli/src/runtime/mounted-turn-owned-relay.ts";

// ---------------------------------------------------------------------------
// mounted-turn-owned-relay: onHandoffAccepted + guard fields
// ---------------------------------------------------------------------------

function makeBrokerForGuard(handoffStatus: "pending" | "deferred" | "accepted" | "none") {
  const handoff =
    handoffStatus === "none"
      ? null
      : {
          handoffId: "handoff_guard_1",
          collabId: "collab_guard",
          senderAgent: "codex" as const,
          targetAgent: "claude" as const,
          requestText: "Do the work",
          status: handoffStatus,
        };
  return {
    control: {
      getRelayTurnState: vi.fn(() => ({
        collabId: "collab_guard",
        turnOwner: "claude" as const,
        waitingAgent: "codex" as "codex" | "claude" | null,
        unresolvedHandoffId: handoff ? "handoff_guard_1" : null,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- vi.fn wrapper widens to `string` without it
        handoffState: (handoffStatus === "none" ? "idle" : handoffStatus) as
          | "idle"
          | "pending"
          | "deferred"
          | "accepted",
        handoffAgeMs: 5_000 as number | null,
      })),
      getRelayHandoff: vi.fn(() => handoff),
      acceptRelayHandoff: vi.fn(),
      declineRelayHandoff: vi.fn(),
      deferRelayHandoff: vi.fn(),
      markRelayHandoffStale: vi.fn(),
      handoffBackRelay: vi.fn(),
    },
  };
}

describe("mounted-turn-owned-relay: onHandoffAccepted callback", () => {
  it("calls onHandoffAccepted when a pending handoff is accepted", async () => {
    const onHandoffAccepted = vi.fn();
    const broker = makeBrokerForGuard("pending");
    const relay = createMountedTurnOwnedRelay({
      broker,
      collabId: "collab_guard",
      currentAgent: "claude",
      writeLocalMessage: vi.fn(),
      writeUserInput: vi.fn(),
      openComposer: vi.fn(),
      onHandoffAccepted,
    });
    await relay.acceptPendingHandoff();
    expect(onHandoffAccepted).toHaveBeenCalledTimes(1);
  });

  it("resets autoHandbackFiredFor so a subsequent checkIdleActions does not re-fire", async () => {
    const broker = makeBrokerForGuard("pending");
    const relay = createMountedTurnOwnedRelay({
      broker,
      collabId: "collab_guard",
      currentAgent: "claude",
      writeLocalMessage: vi.fn(),
      writeUserInput: vi.fn(),
      openComposer: vi.fn(),
    });
    await relay.acceptPendingHandoff();
    // Switch state to idle; checkIdleActions should be a no-op
    broker.control.getRelayHandoff.mockReturnValue(null);
    broker.control.getRelayTurnState.mockReturnValue({
      collabId: "collab_guard",
      turnOwner: "claude" as const,
      waitingAgent: null,
      unresolvedHandoffId: null,
      handoffState: "idle" as const,
      handoffAgeMs: null,
    });
    await relay.checkIdleActions();
    expect(broker.control.handoffBackRelay).not.toHaveBeenCalled();
  });
});

describe("mounted-turn-owned-relay: declinePendingHandoff resets autoAcceptFiredFor", () => {
  it("calls broker declineRelayHandoff and does not leave a stale accept guard", () => {
    const broker = makeBrokerForGuard("pending");
    const relay = createMountedTurnOwnedRelay({
      broker,
      collabId: "collab_guard",
      currentAgent: "claude",
      writeLocalMessage: vi.fn(),
      writeUserInput: vi.fn(),
      openComposer: vi.fn(),
    });
    relay.declinePendingHandoff();
    expect(broker.control.declineRelayHandoff).toHaveBeenCalledWith({
      handoffId: "handoff_guard_1",
      now: expect.any(String),
    });
  });
});
