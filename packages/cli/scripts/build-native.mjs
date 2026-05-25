#!/usr/bin/env node
// Compile the clipboard changeCount helper (Swift) into dist/native.
//
// Must run AFTER bundle.mjs, which wipes dist/ at start. The helper is the only
// way to read NSPasteboard.changeCount (osascript does not surface it). It is
// strictly optional: the JS wrapper (clipboard-change-count.ts) degrades to
// `null` when the binary is absent, so this build step never fails the overall
// build — it skips cleanly off-darwin or when swiftc is unavailable.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

if (process.platform !== "darwin") {
	console.log("build-native: skip (non-darwin)");
	process.exit(0);
}

let swiftcAvailable = true;
try {
	execFileSync("swiftc", ["--version"], { stdio: "ignore" });
} catch {
	swiftcAvailable = false;
}
if (!swiftcAvailable) {
	console.log("build-native: skip (swiftc not found)");
	process.exit(0);
}

const src = path.join(pkgRoot, "src/native/clipboard-change-count.swift");
const outDir = path.join(pkgRoot, "dist/native");
const out = path.join(outDir, "clipboard-change-count");
mkdirSync(outDir, { recursive: true });

try {
	execFileSync("swiftc", ["-O", src, "-o", out], { stdio: "inherit" });
	console.log("build-native: wrote dist/native/clipboard-change-count");
} catch (err) {
	// Non-fatal: the wrapper degrades to null when the binary is missing.
	console.log(
		`build-native: skip (compile failed: ${err instanceof Error ? err.message : String(err)})`,
	);
}
