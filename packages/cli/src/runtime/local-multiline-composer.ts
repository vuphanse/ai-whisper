import {
	normalizeTerminalInput,
	type NormalizedInputState,
} from "./terminal-input-normalizer.js";

const CLEAR_LINE = "\r\u001b[2K";

export function createLocalModalLineReader(input: {
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const canManageRawMode =
		ttyStdin.isTTY &&
		typeof ttyStdin.setRawMode === "function" &&
		!process.env.AI_WHISPER_ADOPTED_TTY;
	let inputState: NormalizedInputState = {};
	let closed = false;
	let currentLine = "";
	let pendingResolve: ((line: string) => void) | null = null;
	let pendingReject: ((error: Error) => void) | null = null;

	function setModalRawMode(mode: boolean) {
		if (canManageRawMode) {
			ttyStdin.setRawMode?.(mode);
		}
	}

	function resolveLine(line: string) {
		const resolve = pendingResolve;
		pendingResolve = null;
		pendingReject = null;
		currentLine = "";
		resolve?.(line);
	}

	function rejectLine(error: Error) {
		const reject = pendingReject;
		pendingResolve = null;
		pendingReject = null;
		currentLine = "";
		reject?.(error);
	}

	function onData(chunk: Buffer | string) {
		if (closed || pendingResolve === null) {
			return;
		}

		const normalized = normalizeTerminalInput({
			raw: String(chunk),
			state: inputState,
		});
		inputState = normalized.state;

		for (const char of normalized.text) {
			if (char === "\u0003") {
				input.stdout.write("^C\n");
				rejectLine(new Error("Modal input cancelled"));
				return;
			}
			if (char === "\r" || char === "\n") {
				input.stdout.write("\n");
				resolveLine(currentLine);
				return;
			}
			if (char === "\u0008" || char === "\u007f") {
				if (currentLine.length > 0) {
					currentLine = currentLine.slice(0, -1);
					input.stdout.write("\b \b");
				}
				continue;
			}

			currentLine += char;
			input.stdout.write(char);
		}
	}

	setModalRawMode(true);
	input.stdin.on("data", onData);

	return {
		readLine: () =>
			new Promise<string>((resolve, reject) => {
				pendingResolve = resolve;
				pendingReject = reject;
				currentLine = "";
			}),
		close: () => {
			if (closed) {
				return;
			}
			closed = true;
			input.stdin.off("data", onData);
			setModalRawMode(Boolean(previousRawMode));
			if (pendingReject) {
				rejectLine(new Error("Modal input closed"));
			}
		},
	};
}

export function createLocalModalConfirm(input: {
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
	message: string;
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const canManageRawMode =
		ttyStdin.isTTY &&
		typeof ttyStdin.setRawMode === "function" &&
		!process.env.AI_WHISPER_ADOPTED_TTY;
	let inputState: NormalizedInputState = {};

	function setModalRawMode(mode: boolean) {
		if (canManageRawMode) {
			ttyStdin.setRawMode?.(mode);
		}
	}

	return {
		run: () =>
			new Promise<boolean>((resolve, reject) => {
				let settled = false;

				function finish(result: boolean) {
					if (settled) return;
					settled = true;
					input.stdin.off("data", onData);
					setModalRawMode(Boolean(previousRawMode));
					input.stdout.write(CLEAR_LINE);
					resolve(result);
				}

				function fail(error: Error) {
					if (settled) return;
					settled = true;
					input.stdin.off("data", onData);
					setModalRawMode(Boolean(previousRawMode));
					reject(error);
				}

				function onData(chunk: Buffer | string) {
					const normalized = normalizeTerminalInput({
						raw: String(chunk),
						state: inputState,
					});
					inputState = normalized.state;

					for (const char of normalized.text) {
						if (char === "\u0003") {
							input.stdout.write("^C");
							fail(new Error("Modal confirmation cancelled"));
							return;
						}
						if (char === "\u001b") {
							finish(false);
							return;
						}
						if (char === "\r" || char === "\n") {
							finish(true);
							return;
						}
					}
				}

				input.stdout.write(`${CLEAR_LINE}${input.message}`);
				setModalRawMode(true);
				input.stdin.on("data", onData);
			}),
	};
}

export function createLocalMultilineComposer(input: {
	prompt: string;
	initialValue: string;
	writeLocalMessage: (text: string) => void;
	readLine: () => Promise<string>;
}) {
	return {
		async run(): Promise<string | null> {
			const lines = input.initialValue.length > 0 ? input.initialValue.split("\n") : [];
			input.writeLocalMessage(
				`${input.prompt}\n[ai-whisper] Enter additional lines. Submit with /submit or cancel with /cancel.\n---\n${input.initialValue}`,
			);
			while (true) {
				const line = await input.readLine();
				if (line === "/cancel") return null;
				if (line === "/submit") return lines.join("\n").trimEnd();
				lines.push(line);
			}
		},
	};
}
