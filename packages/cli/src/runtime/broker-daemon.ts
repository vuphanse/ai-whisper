import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function resolveBrokerDaemonLaunch(metaUrl: string = import.meta.url): {
	command: string;
	args: string[];
} {
	const runtimeDir = dirname(fileURLToPath(metaUrl));
	const directJsPath = resolve(runtimeDir, "../bin/broker-daemon.js");
	if (existsSync(directJsPath)) {
		return {
			command: process.execPath,
			args: [directJsPath],
		};
	}

	const sourceTsPath = resolve(runtimeDir, "../bin/broker-daemon.ts");
	if (existsSync(sourceTsPath)) {
		return {
			command: process.execPath,
			args: ["--import", "tsx", sourceTsPath],
		};
	}

	const builtJsPath = resolve(runtimeDir, "../../dist/bin/broker-daemon.js");
	if (existsSync(builtJsPath)) {
		return {
			command: process.execPath,
			args: [builtJsPath],
		};
	}

	throw new Error("Unable to resolve broker daemon entrypoint.");
}

export function spawnBrokerDaemon(
	sqlitePath: string,
	host: string,
	port: number,
	collabId: string,
): number {
	const launch = resolveBrokerDaemonLaunch();
	const child = spawn(launch.command, launch.args, {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			AI_WHISPER_BROKER_SQLITE: sqlitePath,
			AI_WHISPER_BROKER_HOST: host,
			AI_WHISPER_BROKER_PORT: String(port),
			AI_WHISPER_COLLAB_ID: collabId,
		},
	});
	child.unref();
	return child.pid!;
}
