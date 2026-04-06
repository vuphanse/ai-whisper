import { describe, expect, it } from "vitest";
import { createCli, resolveReconnectTargetMode } from "../packages/cli/src/create-cli.ts";

describe("cli command wiring", () => {
	it("registers collab subcommands: start, status, tell, stop, attach, rebind, recover, reconnect, inspect, mount, relay-monitor", () => {
		const cli = createCli();
		const collab = cli.commands.find((c) => c.name() === "collab");
		expect(collab).toBeDefined();

		const subcommandNames = collab!.commands.map((c) => c.name()).sort();
		expect(subcommandNames).toEqual(["attach", "inspect", "mount", "rebind", "reconnect", "recover", "relay-monitor", "start", "status", "stop", "tell"]);
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

describe("mutually exclusive tty flags", () => {
	function buildCli() {
		const cli = createCli();
		cli.exitOverride();
		cli.configureOutput({ writeOut: () => {}, writeErr: () => {} });
		return cli;
	}

	it("attach rejects --adopt-current-tty and --tty together", async () => {
		const cli = buildCli();
		await expect(
			cli.parseAsync(["node", "whisper", "collab", "attach", "codex", "--adopt-current-tty", "--tty", "/dev/ttys099", "--workspace", "/tmp/test"]),
		).rejects.toThrow(/mutually exclusive/i);
	});

	it("rebind rejects --adopt-current-tty and --tty together", async () => {
		const cli = buildCli();
		await expect(
			cli.parseAsync(["node", "whisper", "collab", "rebind", "codex", "--replace", "--adopt-current-tty", "--tty", "/dev/ttys099", "--workspace", "/tmp/test"]),
		).rejects.toThrow(/mutually exclusive/i);
	});

	it("reconnect rejects --adopt-current-tty and --tty together", async () => {
		const cli = buildCli();
		await expect(
			cli.parseAsync(["node", "whisper", "collab", "reconnect", "codex", "--adopt-current-tty", "--tty", "/dev/ttys099", "--workspace", "/tmp/test"]),
		).rejects.toThrow(/mutually exclusive/i);
	});
});

describe("reconnect target-mode selection", () => {
	it("leaves targetMode undefined when reconnect is invoked without tty flags", () => {
		expect(resolveReconnectTargetMode({})).toBeUndefined();
	});

	it("uses adopt_current_tty when --adopt-current-tty is provided", () => {
		expect(resolveReconnectTargetMode({ adoptCurrentTty: true })).toBe("adopt_current_tty");
	});

	it("uses explicit_tty when --tty is provided", () => {
		expect(resolveReconnectTargetMode({ tty: "/dev/ttys099" })).toBe("explicit_tty");
	});
});
