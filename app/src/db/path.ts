import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

/** Pasta de dados do app. Fora do repo, porque banco nao e codigo. */
export function appHome(): string {
  const custom = process.env.LOCUM_HOME;
  const dir =
    custom && custom.length > 0
      ? custom
      : join(homedir(), "Library", "Application Support", "locum");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(appHome(), "watchers.db");
}

export interface SmokeHome {
  dir: string;
  /** Criada aqui, e por isso apagada no fim. */
  temporary: boolean;
  cleanup(): void;
}

/**
 * Pasta de dados da fumaça.
 *
 * A fumaça planta pendência, execução e cadastro sintéticos, e rodada à mão na
 * árvore principal caía no banco de verdade: foi assim que "PR Review, passo
 * Comentar no PR" apareceu na inbox misturado com dado real. Sem `LOCUM_HOME`
 * ela ganha um rascunho vazio, apagado na saída. Com ele, quem chamou já
 * escolheu onde, como o loop faz, e a pasta fica.
 *
 * Precisa rodar antes de qualquer import do núcleo, que abre o banco no import.
 */
export function smokeHome(env: NodeJS.ProcessEnv = process.env): SmokeHome {
  const escolhida = env.LOCUM_HOME;
  if (escolhida && escolhida.length > 0) {
    return { dir: escolhida, temporary: false, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "locum-smoke-"));
  env.LOCUM_HOME = dir;
  return { dir, temporary: true, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
