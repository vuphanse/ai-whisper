import { describe, expect, it } from "vitest";
import {
  companionHeartbeatSchema,
  companionRegistrationSchema,
  createProviderIdentity,
  mockProviderReplySchema,
  providerCapabilitiesSchema,
} from "../packages/shared/src/index.ts";

describe("provider and companion contracts", () => {
  it("validates provider identity, capabilities, and companion registration payloads", () => {
    const provider = createProviderIdentity({
      providerId: "mock-provider",
      toolFamily: "mock-agent",
      providerVersion: "1.0.0",
    });

    expect(provider.providerId).toBe("mock-provider");

    expect(
      providerCapabilitiesSchema.parse({
        supportsDirectPackets: true,
        supportsNormalization: false,
        supportsRelayInterception: false,
        supportsLocalBuffering: false,
        supportsLaunchHooks: false,
        extensions: {},
      }).supportsDirectPackets,
    ).toBe(true);

    expect(
      companionRegistrationSchema.parse({
        version: 1,
        collabId: "collab_phase4",
        sessionId: "session_codex_1",
        provider,
        capabilities: {
          supportsDirectPackets: true,
          supportsNormalization: false,
          supportsRelayInterception: false,
          supportsLocalBuffering: false,
          supportsLaunchHooks: false,
          extensions: {},
        },
        registeredAt: "2026-04-03T00:00:00.000Z",
      }).sessionId,
    ).toBe("session_codex_1");

    expect(
      companionHeartbeatSchema.parse({
        version: 1,
        collabId: "collab_phase4",
        sessionId: "session_codex_1",
        healthState: "healthy",
        sentAt: "2026-04-03T00:00:01.000Z",
      }).healthState,
    ).toBe("healthy");

    expect(
      mockProviderReplySchema.parse({
        kind: "review",
        content: "Needs explicit retry handling.",
        transitionIntent: "awaiting_user",
      }).kind,
    ).toBe("review");
  });
});
