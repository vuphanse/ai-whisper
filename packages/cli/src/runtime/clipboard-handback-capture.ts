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
	/** Called once if clipboard has not changed after the initial trigger delay.
	 *  Use this to dismiss a picker or confirm a secondary prompt (e.g. Claude Code's /copy picker). */
	confirmPicker?: () => void | Promise<void>;
	readClipboard?: () => Promise<string>;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
	delayMs?: number;
	/** Delay before first poll; also the window given to confirmPicker to fire. Defaults to delayMs. */
	triggerDelayMs?: number;
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
	const triggerDelayMs = input.triggerDelayMs ?? delayMs;

	const before = (await readClipboard()).trim();
	await input.triggerCopy();

	// Wait for the trigger to settle, then check if clipboard changed already.
	// If not (e.g. a picker is blocking), fire confirmPicker before polling.
	await sleep(triggerDelayMs);
	const afterTrigger = (await readClipboard()).trim();
	if (afterTrigger.length > 0 && afterTrigger !== before) {
		return afterTrigger;
	}
	if (input.confirmPicker) {
		await input.confirmPicker();
	}

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await sleep(delayMs);
		const current = (await readClipboard()).trim();
		if (current.length > 0 && current !== before) {
			return current;
		}
	}

	return null;
}
