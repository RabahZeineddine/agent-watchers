import type { Config } from "drizzle-kit";
import { dbPath } from "./src/db/path.js";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: dbPath() },
} satisfies Config;
