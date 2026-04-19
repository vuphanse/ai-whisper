import { execSync } from "node:child_process";
import { createServer } from "node:net";

export async function isPortFree(
	port: number,
	host = "127.0.0.1",
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, host);
	});
}

export function findPortOwnerPid(port: number): number | null {
	try {
		const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
			stdio: ["ignore", "pipe", "ignore"],
		}).toString().trim();
		if (!out) return null;
		const firstLine = out.split("\n")[0]!;
		const pid = Number(firstLine);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}
