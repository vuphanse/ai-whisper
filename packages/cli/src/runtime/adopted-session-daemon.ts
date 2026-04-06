import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adoptSessionBinPath = resolve(__dirname, "../bin/adopt-session.js");

export function startAdoptionDaemon(input: {
	target: "codex" | "claude";
	workspaceRoot: string;
	ttyPath: string;
	claimId: string;
	secret: string;
}): number {
	const child = spawn(
		process.execPath,
		[
			adoptSessionBinPath,
			input.target,
			"--workspace",
			input.workspaceRoot,
			"--tty",
			input.ttyPath,
			"--claim-id",
			input.claimId,
		],
		{
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				AI_WHISPER_CLAIM_SECRET: input.secret,
			},
		},
	);
	child.unref();
	if (child.pid === undefined) {
		throw new Error(`Failed to spawn adoption daemon for ${input.target}`);
	}
	return child.pid;
}
