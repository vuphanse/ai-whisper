import type { CompanionProvider } from "@ai-whisper/shared";

export type ProviderRegistry = {
  register(provider: CompanionProvider): void;
  get(providerId: string): CompanionProvider;
};

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, CompanionProvider>();

  return {
    register(provider) {
      providers.set(provider.getIdentity().providerId, provider);
    },
    get(providerId) {
      const provider = providers.get(providerId);

      if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
      }

      return provider;
    },
  };
}
