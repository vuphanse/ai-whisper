let nextPid = 99000;

/**
 * Returns a fake broker spawner for tests that don't need a real daemon.
 * Returns a synthetic PID that won't collide with real processes.
 */
export function fakeBrokerSpawn(): (_sqlitePath: string, _host: string, _port: number) => number {
	return () => nextPid++;
}
