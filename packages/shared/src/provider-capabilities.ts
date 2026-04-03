import { z } from "zod";

export const providerCapabilitiesSchema = z.object({
  supportsDirectPackets: z.boolean(),
  supportsNormalization: z.boolean(),
  supportsRelayInterception: z.boolean(),
  supportsLocalBuffering: z.boolean(),
  supportsLaunchHooks: z.boolean(),
  extensions: z.record(z.string(), z.unknown()),
});

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;
