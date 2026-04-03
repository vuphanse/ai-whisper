export const endpointHealthStates = ["healthy", "degraded", "offline"] as const;

export type EndpointHealthState = (typeof endpointHealthStates)[number];
