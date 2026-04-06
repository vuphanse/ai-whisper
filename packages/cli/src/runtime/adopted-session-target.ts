import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function resolveCurrentTty(): string {
	const ttyPath = execFileSync("tty", [], { encoding: "utf8" }).trim();
	if (!ttyPath.startsWith("/dev/")) {
		throw new Error(
			"Current shell is not attached to a local tty. `--adopt-current-tty` requires a real tty-backed shell.",
		);
	}
	if (!existsSync(ttyPath)) {
		throw new Error(`Resolved tty does not exist: ${ttyPath}`);
	}
	return ttyPath;
}

export function validateExplicitTty(ttyPath: string): string {
	if (!ttyPath.startsWith("/dev/")) {
		throw new Error(`TTY path must be a local device path: ${ttyPath}`);
	}
	if (!existsSync(ttyPath)) {
		throw new Error(`TTY path does not exist: ${ttyPath}`);
	}
	return ttyPath;
}
