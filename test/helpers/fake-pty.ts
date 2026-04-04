type DataHandler = (data: string) => void;

export function createFakePty() {
	const handlers: DataHandler[] = [];
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
		emitData(data: string) {
			for (const handler of handlers) {
				handler(data);
			}
		},
		kill() {},
		resize() {},
	};
}
