import { z } from "zod";

// Phase 4 upgrades provider identity from a plain type helper to a validated
// schema because companion registration now parses provider identity at runtime.
export const providerIdentitySchema = z.object({
	providerId: z.string().min(1),
	toolFamily: z.string().min(1),
	providerVersion: z.string().min(1),
});

export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

export function createProviderIdentity(
	input: ProviderIdentity,
): ProviderIdentity {
	return providerIdentitySchema.parse(input);
}
