#!/usr/bin/env node
import { loadDotEnv } from "../runtime/load-dot-env.js";
import { createCli, resolveCliVersion } from "../create-cli.js";
import { reportVersion } from "../runtime/version-check.js";

loadDotEnv();

// Handle -v/--version here (not via commander's sync version action) so the
// best-effort "newer version available" registry check can run asynchronously.
// createCli() still registers .version() so the flag shows in --help.
const argv = process.argv.slice(2);
if (argv.includes("-v") || argv.includes("--version")) {
	await reportVersion({
		current: resolveCliVersion(),
		disabled: process.env.AI_WHISPER_NO_UPDATE_CHECK === "1",
	});
	process.exit(0);
}

await createCli().parseAsync(process.argv);
