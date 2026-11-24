import Database from "@tauri-apps/plugin-sql";

let database: Promise<Database> | undefined;

export function openDatabase(): Promise<Database> {
  database ??= Database.load("sqlite:meetings.db");
  return database;
}
