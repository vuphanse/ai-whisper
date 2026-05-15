import type Database from "better-sqlite3";

export const DEFAULT_PORT_RANGE: readonly [number, number] = [4500, 4999];

export async function allocatePort(
	db: Database.Database,
	opts: {
		range?: readonly [number, number];
		isPortFreeOs: (port: number) => Promise<boolean>;
	},
): Promise<number> {
	const [lo, hi] = opts.range ?? DEFAULT_PORT_RANGE;
	const taken = new Set(
		(db.prepare("SELECT port FROM broker_daemon").all() as Array<{ port: number }>).map(
			(r) => r.port,
		),
	);
	for (let p = lo; p <= hi; p++) {
		if (taken.has(p)) continue;
		if (await opts.isPortFreeOs(p)) return p;
	}
	throw new Error(`No free port available in [${lo}, ${hi}]`);
}
