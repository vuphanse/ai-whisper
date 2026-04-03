export const companionCorePackage = {
	name: "@ai-whisper/companion-core",
} as const;

export { createCompanionRuntime } from "./create-companion-runtime.js";
export { createMockProvider } from "./mock-provider.js";
export { createProviderRegistry } from "./provider-registry.js";
