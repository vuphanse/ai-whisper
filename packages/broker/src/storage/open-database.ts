import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  return new Database(path);
}
