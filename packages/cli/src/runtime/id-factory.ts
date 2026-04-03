function normalizeTimestamp(now: string): string {
	return now.replace(/[^0-9]/g, "");
}

export function createCliCollabId(now: string): `collab_${string}` {
	return `collab_${normalizeTimestamp(now)}`;
}

export function createCliSessionId(
	agentType: "codex" | "claude",
	now: string,
): `session_${string}` {
	return `session_${agentType}_${normalizeTimestamp(now)}`;
}

export function createCliThreadId(now: string): `thread_${string}` {
	return `thread_${normalizeTimestamp(now)}`;
}

export function createCliWorkItemId(now: string): `work_${string}` {
	return `work_${normalizeTimestamp(now)}`;
}
