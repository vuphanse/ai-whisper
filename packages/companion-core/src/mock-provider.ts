import {
	createProviderIdentity,
	type CompanionProvider,
	type ProviderCapabilities,
	type ProviderReply,
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
		handleWork(request: ProviderWorkRequest): Promise<ProviderReply> {
			if (request.requestedAction === "review_plan") {
				return Promise.resolve({
					kind: "review",
					content: "Mock review: add explicit retry policy.",
					transitionIntent: "awaiting_user",
				});
			}

			return Promise.resolve({
				kind: "answer",
				content: `Mock result for ${request.requestedAction}`,
				transitionIntent: "completed",
			});
		},
	};
}
