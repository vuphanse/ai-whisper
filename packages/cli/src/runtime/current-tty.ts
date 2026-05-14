import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function resolveCurrentTty(): string {
	const stdin = process.stdin as NodeJS.ReadStream & { path?: string };
	const ttyPath =
		stdin.isTTY && typeof stdin.path === "string"
			? stdin.path
			: execFileSync("tty", [], {
					encoding: "utf8",
					stdio: ["inherit", "pipe", "pipe"],
				}).trim();
	if (!ttyPath.startsWith("/dev/")) {
		throw new Error(
			"Current shell is not attached to a local tty. This command requires a real tty-backed shell.",
		);
	}
	if (!existsSync(ttyPath)) {
		throw new Error(`Resolved tty does not exist: ${ttyPath}`);
	}
	return ttyPath;
}
