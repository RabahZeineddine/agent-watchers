import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";

const migracoes = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Banco em memória com o esquema das migrações, um por teste.
 *
 * Vem das migrações, e não de um `create table` escrito aqui, para que o teste
 * enxergue o mesmo esquema que o aplicativo instalado recebe na subida.
 */
export function bancoDeTeste() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migracoes });
  return db;
}
