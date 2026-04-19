import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
	const db = new Database(path);
	// WAL lets concurrent readers proceed without blocking writers; busy_timeout
	// makes writers wait for a held lock instead of failing with SQLITE_BUSY.
	// Multiple processes (broker daemon, mount commands, relay-monitor) share
	// this file, so both pragmas are required to avoid startup-race crashes.
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	return db;
}
