import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const NODE_PTY_DIR_CANDIDATES = [
	"../build/Release",
	"../build/Debug",
	`../prebuilds/${process.platform}-${process.arch}`,
	"./build/Release",
	"./build/Debug",
	`./prebuilds/${process.platform}-${process.arch}`,
];

export function ensureNodePtySpawnHelperExecutable(input: {
	unixTerminalPath: string;
}): string | null {
	const unixTerminalPath = input.unixTerminalPath;
	const unixTerminalDir = dirname(unixTerminalPath);

	for (const candidateDir of NODE_PTY_DIR_CANDIDATES) {
		const helperPath = resolve(unixTerminalDir, candidateDir, "spawn-helper");
		if (!existsSync(helperPath)) {
			continue;
		}

		const currentMode = statSync(helperPath).mode;
		if ((currentMode & 0o111) === 0) {
			chmodSync(helperPath, currentMode | 0o755);
		}

		return helperPath;
	}

	return null;
}
