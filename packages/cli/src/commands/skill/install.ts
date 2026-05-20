import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillInstallTarget = "claude" | "codex" | "all";

export interface SkillInstallInput {
	target: SkillInstallTarget;
	force?: boolean;
	// Test-only overrides:
	fakeHome?: string;
	bundledSkillsDir?: string;
}

export interface SkillInstallResult {
	installedAt: string[];
}

function defaultBundledSkillsDir(): string {
	// Compiled to dist/commands/skill/install.js. dist/skills/ is at
	// ../../skills from there.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "skills");
}

function homeForTarget(target: "claude" | "codex", fakeHome?: string): string {
	const home = fakeHome ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) throw new Error("Could not determine $HOME for skill install destination");
	return path.join(home, target === "claude" ? ".claude" : ".codex", "skills");
}

export async function runSkillInstall(
	input: SkillInstallInput,
): Promise<SkillInstallResult> {
	const bundledDir = input.bundledSkillsDir ?? defaultBundledSkillsDir();
	try {
		await stat(bundledDir);
	} catch {
		throw new Error(
			`Bundled skills directory not found at ${bundledDir}. Run \`pnpm build\` first (or reinstall the CLI package).`,
		);
	}

	const skills = (await readdir(bundledDir, { withFileTypes: true }))
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	if (skills.length === 0) {
		throw new Error(`No skills found in ${bundledDir}.`);
	}

	const targets: ("claude" | "codex")[] =
		input.target === "all" ? ["claude", "codex"] : [input.target];

	const installedAt: string[] = [];

	for (const t of targets) {
		const destBase = homeForTarget(t, input.fakeHome);
		await mkdir(destBase, { recursive: true });
		for (const skill of skills) {
			const src = path.join(bundledDir, skill);
			const dest = path.join(destBase, skill);
			let destExists = false;
			try {
				await stat(dest);
				destExists = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (destExists && !input.force) {
				throw new Error(
					`Skill destination already exists at ${dest}. Re-run with --force to overwrite.`,
				);
			}
			await cp(src, dest, { recursive: true, force: true });
			installedAt.push(path.join(dest, "SKILL.md"));
		}
	}

	return { installedAt };
}
