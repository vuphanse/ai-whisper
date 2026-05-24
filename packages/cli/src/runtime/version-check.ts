// Best-effort "newer version available" notice for `whisper -v` / `--version`.
// Never throws and never blocks beyond a short timeout: a failed/slow/offline
// lookup degrades to printing just the current version.

const PKG = "ai-whisper";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG}/latest`;
const DEFAULT_TIMEOUT_MS = 1500;

function coreParts(v: string): [number, number, number] {
	const core = v.split("-")[0] ?? "";
	const [a, b, c] = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
	return [a ?? 0, b ?? 0, c ?? 0];
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
	const cand = coreParts(candidate);
	const cur = coreParts(current);
	for (let i = 0; i < 3; i++) {
		if (cand[i]! > cur[i]!) return true;
		if (cand[i]! < cur[i]!) return false;
	}
	// Equal core: a stable release outranks a prerelease of the same core
	// (0.1.4 > 0.1.4-beta). Same-or-lower prerelease detail is treated as not newer.
	const candPre = candidate.includes("-");
	const curPre = current.includes("-");
	if (candPre !== curPre) return !candPre;
	return false;
}

/** Pure: the version line, plus an update notice when `latest` is newer. */
export function formatVersionReport(current: string, latest: string | null): string {
	if (latest && isNewerVersion(latest, current)) {
		return (
			`${current}\n` +
			`A newer version is available: ${current} → ${latest}  ·  ` +
			`update: npm install -g ${PKG}@latest`
		);
	}
	return current;
}

/** Fetch the published `latest` version from the npm registry, or null on any failure. */
export async function fetchLatestVersion(opts?: {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<string | null> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const f = opts?.fetchImpl ?? fetch;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await f(REGISTRY_LATEST, { signal: ac.signal });
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: unknown };
		return typeof body.version === "string" ? body.version : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Print the current version and (unless disabled) an update notice if one exists. */
export async function reportVersion(input: {
	current: string;
	write?: (line: string) => void;
	fetchLatest?: () => Promise<string | null>;
	disabled?: boolean;
}): Promise<void> {
	const write = input.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	if (input.disabled) {
		write(input.current);
		return;
	}
	const latest = await (input.fetchLatest ? input.fetchLatest() : fetchLatestVersion());
	write(formatVersionReport(input.current, latest));
}
