import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { dbPath } from "./path.js";
import * as schema from "./schema.js";

const sqlite = new Database(dbPath());
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };
export const rawDb = sqlite;
