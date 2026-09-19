import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** Pasta de dados do app. Fora do repo, porque banco nao e codigo. */
export function appHome(): string {
  const custom = process.env.AGENT_WATCHERS_HOME;
  const dir =
    custom && custom.length > 0
      ? custom
      : join(homedir(), "Library", "Application Support", "agent-watchers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(appHome(), "watchers.db");
}
