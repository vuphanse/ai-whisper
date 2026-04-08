import { createInterface } from "node:readline/promises";

export function createLocalModalLineReader(input: {
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
}) {
	const rl = createInterface({
		input: input.stdin,
		output: input.stdout,
		terminal: true,
	});

	return {
		readLine: () => rl.question(""),
		close: () => rl.close(),
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
