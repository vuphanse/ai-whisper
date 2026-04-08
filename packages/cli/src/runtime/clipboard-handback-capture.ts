import { execFile } from "node:child_process";

function execFileText(command: string, args: string[] = []): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
			if (error) {
				reject(
					error instanceof Error
						? error
						: new Error("Clipboard command failed"),
				);
				return;
			}
			resolve(stdout);
		});
	});
}

export async function captureClipboardHandback(input: {
	triggerCopy(): void | Promise<void>;
	readClipboard?: () => Promise<string>;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
	delayMs?: number;
}): Promise<string | null> {
	const readClipboard =
		input.readClipboard ??
		(() => {
			if (process.platform !== "darwin") {
				return Promise.resolve("");
			}
			return execFileText("pbpaste");
		});
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = input.attempts ?? 10;
	const delayMs = input.delayMs ?? 100;

	const before = (await readClipboard()).trim();
	await input.triggerCopy();

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await sleep(delayMs);
		const current = (await readClipboard()).trim();
		if (current.length > 0 && current !== before) {
			return current;
		}
	}

	return null;
}
