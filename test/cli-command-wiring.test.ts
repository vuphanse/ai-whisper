import { describe, expect, it } from "vitest";
import { createCli } from "../packages/cli/src/create-cli.ts";

describe("cli command wiring", () => {
	it("registers collab subcommands: start, status, tell, stop, attach, rebind, recover, reconnect, inspect", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab");
		expect(collab).toBeDefined();

		const subcommandNames = collab!.commands.map((c) => c.name()).sort();
		expect(subcommandNames).toEqual(["attach", "inspect", "rebind", "reconnect", "recover", "start", "status", "stop", "tell"]);
	});

	it("tell subcommand accepts --target and --action options", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab")!;
		const tell = collab.commands.find((c) => c.name() === "tell");
		expect(tell).toBeDefined();

		const optionNames = tell!.options.map((o) => o.long);
		expect(optionNames).toContain("--target");
		expect(optionNames).toContain("--action");
	});
});
