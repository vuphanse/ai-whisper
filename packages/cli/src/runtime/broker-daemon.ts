import { spawn } from "node:child_process";

export async function assessBrokerDaemon(input: {
	host: string;
	port: number;
	pid: number;
	fetchImpl?: typeof fetch;
	killImpl?: typeof process.kill;
}) {
	const fetchImpl = input.fetchImpl ?? fetch;
	const killImpl = input.killImpl ?? process.kill.bind(process);

	let pidAlive = true;
	try {
		killImpl(input.pid, 0);
	} catch {
		pidAlive = false;
	}

	let httpReachable = false;
	try {
		const response = await fetchImpl(`http://${input.host}:${input.port}/health`);
		httpReachable = response.ok;
	} catch {
		httpReachable = false;
	}

	return {
		pidAlive,
		httpReachable,
		ok: pidAlive && httpReachable,
	} as const;
}

export function spawnBrokerDaemon(sqlitePath: string, host: string, port: number): number {
	const child = spawn("node", [new URL("../bin/broker-daemon.js", import.meta.url).pathname], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			AI_WHISPER_BROKER_SQLITE: sqlitePath,
			AI_WHISPER_BROKER_HOST: host,
			AI_WHISPER_BROKER_PORT: String(port),
		},
	});
	child.unref();
	return child.pid!;
}
