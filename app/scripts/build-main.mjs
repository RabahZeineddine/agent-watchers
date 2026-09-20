import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bindingSource = join(
  appDir,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
const bindingTarget = join(appDir, "native", "better_sqlite3-electron.node");

function run(command, args) {
  execFileSync(command, args, { cwd: appDir, stdio: "inherit" });
}

/**
 * O better-sqlite3 instalado fica compilado para o ABI do Node, porque a linha
 * de comando roda por tsx. O Electron tem ABI proprio e recusa esse binario, e
 * os dois nao cabem no mesmo caminho. Entao aqui a gente recompila para o
 * Electron, guarda a copia em native/, e devolve o node_modules ao estado de
 * Node, para nao quebrar a linha de comando.
 */
function ensureElectronBinding() {
  if (existsSync(bindingTarget)) return;

  mkdirSync(dirname(bindingTarget), { recursive: true });
  run("npx", ["electron-rebuild", "-f", "-w", "better-sqlite3"]);
  copyFileSync(bindingSource, bindingTarget);
  run("npm", ["rebuild", "better-sqlite3"]);
}

ensureElectronBinding();

await build({
  entryPoints: [join(appDir, "electron", "main.ts")],
  outfile: join(appDir, "dist", "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  // Dependencia de node_modules fica de fora do pacote: modulo nativo nao se
  // deixa empacotar, e o resto o Electron resolve por node_modules mesmo.
  packages: "external",
});

/**
 * O preload sai num pacote proprio, e aqui `packages: "external"` nao vale.
 *
 * Ele roda em sandbox, onde nao existe resolucao por node_modules: o que nao
 * estiver dentro do arquivo nao carrega. Como o preload so importa `electron`,
 * que o sandbox fornece, basta marcar esse.
 */
await build({
  entryPoints: [join(appDir, "electron", "preload.ts")],
  outfile: join(appDir, "dist", "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
});
