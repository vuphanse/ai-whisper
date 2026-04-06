type DataHandler = (data: string) => void;
type ExitHandler = (e: { exitCode: number }) => void;

export function createFakePty() {
	const handlers: DataHandler[] = [];
	const exitHandlers: ExitHandler[] = [];
	const writes: string[] = [];

	return {
		writes,
		write(data: string) {
			writes.push(data);
		},
		onData(handler: DataHandler) {
			handlers.push(handler);
			return { dispose() {} };
		},
		onExit(handler: ExitHandler) {
			exitHandlers.push(handler);
			return { dispose() {} };
		},
		emitData(data: string) {
			for (const handler of handlers) {
				handler(data);
			}
		},
		emitExit(exitCode = 0) {
			for (const handler of exitHandlers) {
				handler({ exitCode });
			}
		},
		kill() {},
		resize() {},
	};
}
