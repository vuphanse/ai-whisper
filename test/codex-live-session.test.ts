import { describe, it } from "vitest";
import { createCodexLiveSession } from "../packages/adapter-codex/src/index.ts";

// Broker work submission tests have been removed. createCodexLiveSession no
// longer exposes runBrokerWork on its returned InteractiveSessionController.
// Tests will be re-added in Task 5 once the one-shot provider pattern is in place.

describe("codex live session", () => {
	it("can be instantiated without errors", () => {
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
		});

		// Just verify the object has the expected shape.
		if (typeof session.start !== "function") throw new Error("start missing");
		if (typeof session.stop !== "function") throw new Error("stop missing");
		if (typeof session.writeUserInput !== "function") throw new Error("writeUserInput missing");
		if (typeof session.sendLocalMessage !== "function") throw new Error("sendLocalMessage missing");
	});
});
