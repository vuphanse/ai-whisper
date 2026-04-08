export async function submitInjectedProviderInput(input: {
	target: "codex" | "claude";
	text: string;
	writeUserInput: (text: string) => void;
	sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	if (input.target === "codex") {
		// Codex has been the least reliable when large chunks are pasted at once.
		// Type the request as a short keystream, then submit on a separate beat.
		for (const char of input.text) {
			input.writeUserInput(char);
			await sleep(5);
		}
		await sleep(100);
		input.writeUserInput("\r");
		return;
	}

	input.writeUserInput(input.text);
	await sleep(75);
	input.writeUserInput("\r");
}
