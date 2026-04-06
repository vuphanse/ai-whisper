import { openSync, writeSync, closeSync } from "node:fs";
import type { InteractiveSessionController } from "@ai-whisper/shared";

type TtyHandle = {
	write(data: string): void;
	onData(handler: (data: string) => void): void;
	close(): void;
};

function defaultOpenTty(ttyPath: string): TtyHandle {
	const fd = openSync(ttyPath, "w");
	return {
		write(data: string) {
			writeSync(fd, data);
		},
		onData() {
			// Read-side not needed for the adopted session controller —
			// the provider process owns stdin directly via fg.
		},
		close() {
			closeSync(fd);
		},
	};
}

export function createAdoptedInteractiveSession(input: {
	ttyPath: string;
	openTty?: (ttyPath: string) => TtyHandle;
}): InteractiveSessionController {
	let handle: TtyHandle | null = null;

	return {
		start() {
			handle = (input.openTty ?? defaultOpenTty)(input.ttyPath);
			return Promise.resolve();
		},
		stop() {
			handle?.close();
			handle = null;
			return Promise.resolve();
		},
		writeUserInput(data: string) {
			handle?.write(data);
		},
		sendLocalMessage(message: string) {
			handle?.write(message);
		},
	};
}
