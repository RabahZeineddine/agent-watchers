import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { dbPath } from "./path.js";
import * as schema from "./schema.js";

// O binario do better-sqlite3 em node_modules e compilado para o ABI do Node,
// que a linha de comando usa. O Electron tem ABI proprio, entao o processo
// principal aponta LOCUM_SQLITE_BINDING para a copia dele antes de importar
// este modulo. Sem a variavel, vale o caminho padrao.
const nativeBinding = process.env.LOCUM_SQLITE_BINDING;
const sqlite = new Database(
  dbPath(),
  nativeBinding && nativeBinding.length > 0 ? { nativeBinding } : {},
);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
export { schema };
export const rawDb = sqlite;
