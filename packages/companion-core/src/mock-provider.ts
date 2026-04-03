import {
  createProviderIdentity,
  type CompanionProvider,
  type MockProviderReply,
  type ProviderCapabilities,
  type ProviderWorkRequest,
} from "@ai-whisper/shared";

const capabilities: ProviderCapabilities = {
  supportsDirectPackets: true,
  supportsNormalization: false,
  supportsRelayInterception: false,
  supportsLocalBuffering: false,
  supportsLaunchHooks: false,
  extensions: {},
};

export function createMockProvider(): CompanionProvider {
  return {
    getIdentity() {
      return createProviderIdentity({
        providerId: "mock-provider",
        toolFamily: "mock-agent",
        providerVersion: "1.0.0",
      });
    },
    getCapabilities() {
      return capabilities;
    },
    getHealthState() {
      return "healthy";
    },
    async handleWork(request: ProviderWorkRequest): Promise<MockProviderReply> {
      if (request.requestedAction === "review_plan") {
        return {
          kind: "review",
          content: "Mock review: add explicit retry policy.",
          transitionIntent: "awaiting_user",
        };
      }

      return {
        kind: "answer",
        content: `Mock result for ${request.requestedAction}`,
        transitionIntent: "completed",
      };
    },
  };
}
