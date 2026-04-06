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
			"--secret",
			input.secret,
		],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	child.unref();
	return child.pid!;
}
