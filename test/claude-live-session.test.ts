import { describe, it } from "vitest";
import { createClaudeLiveSession } from "../packages/adapter-claude/src/index.ts";

// Broker work submission tests have been removed. createClaudeLiveSession no
// longer exposes runBrokerWork on its returned InteractiveSessionController.
// Tests will be re-added in Task 5 once the one-shot provider pattern is in place.

describe("claude live session", () => {
	it("can be instantiated without errors", () => {
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const session = createClaudeLiveSession({
			config: { executable: "claude", execArgs: [] },
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
