export const brokerHealthStates = ["healthy", "degraded", "offline"] as const;
export const eventTypes = ["broker.started", "broker.stopped"] as const;
export const threadStates = [
  "created",
  "in_progress",
  "awaiting_user",
  "completed",
  "failed",
] as const;
