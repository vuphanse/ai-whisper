#!/usr/bin/env node
// Copy repo-root README.md, LICENSE, and NOTICE into this package so they ship
// in the published npm tarball. The package is published from packages/cli, but
// these files live at the repo root — without this, the npm page shows no
// README and the tarball carries no license. The copies are gitignored; they
// exist only at build/publish time.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, ".."); // packages/cli
const repoRoot = path.resolve(pkgRoot, "..", ".."); // repo root

for (const file of ["README.md", "LICENSE", "NOTICE"]) {
	copyFileSync(path.join(repoRoot, file), path.join(pkgRoot, file));
	console.log(`copy-package-files: ${file} → packages/cli/${file}`);
}
