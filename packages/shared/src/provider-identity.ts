export type ProviderIdentity = {
  providerId: string;
  toolFamily: string;
  providerVersion: string;
};

export function createProviderIdentity(
  input: ProviderIdentity,
): ProviderIdentity {
  return input;
}
