import { describe, expect, it } from "vitest";
import { createCli } from "../packages/cli/src/create-cli.ts";

describe("cli command wiring", () => {
	it("registers collab subcommands: start, status, tell, stop, recover, reconnect, inspect, mount, relay-monitor", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab");
		expect(collab).toBeDefined();

		const subcommandNames = collab!.commands.map((c) => c.name()).sort();
		expect(subcommandNames).toEqual(["inspect", "mount", "reconnect", "recover", "relay-monitor", "start", "status", "stop", "tell"]);
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

	it("inspect subcommand accepts --captures and --watch options", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab")!;
		const inspect = collab.commands.find((c) => c.name() === "inspect");
		expect(inspect).toBeDefined();
		const longs = inspect!.options.map((o) => o.long);
		expect(longs).toContain("--captures");
		expect(longs).toContain("--watch");
	});

	it("inspect's --captures option is optional-value (takes either a chain id or no argument)", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab")!;
		const inspect = collab.commands.find((c) => c.name() === "inspect")!;
		const captures = inspect.options.find((o) => o.long === "--captures");
		expect(captures).toBeDefined();
		expect(captures!.flags).toMatch(/\[/);
	});

	it("inspect subcommand accepts --verdicts option (optional-value)", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab")!;
		const inspect = collab.commands.find((c) => c.name() === "inspect")!;
		const longs = inspect.options.map((o) => o.long);
		expect(longs).toContain("--verdicts");
		const verdicts = inspect.options.find((o) => o.long === "--verdicts")!;
		expect(verdicts.flags).toMatch(/\[/);
	});
});
