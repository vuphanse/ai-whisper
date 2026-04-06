const CLEAR_LINE = "\r\u001b[2K";
const ORANGE = "\u001b[38;5;215m";
const RESET = "\u001b[0m";

export function createBusyIndicator(input: {
	write: (data: string) => void;
}) {
	let busy = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let startedAt = 0;
	let currentSender = "";
	let currentInstruction = "";

	function render() {
		const elapsed = Math.floor((Date.now() - startedAt) / 1000);
		const truncated =
			currentInstruction.length > 50
				? `${currentInstruction.slice(0, 47)}...`
				: currentInstruction;
		input.write(
			`${CLEAR_LINE}${ORANGE}⟳ Processing request from ${currentSender}: "${truncated}" (${elapsed}s)${RESET}`,
		);
	}

	return {
		isBusy() {
			return busy;
		},

		show(params: { senderAgent: string; instruction: string }) {
			busy = true;
			startedAt = Date.now();
			currentSender = params.senderAgent;
			currentInstruction = params.instruction;
			render();
			timer = setInterval(() => {
				render();
			}, 1000);
		},

		hide() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (busy) {
				input.write(CLEAR_LINE);
				busy = false;
			}
		},
	};
}
