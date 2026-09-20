import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
/**
 * Para qual arquitetura reconstruir o binario nativo.
 *
 * O pacote sai para arm64 e x64, e um `.node` so serve para a arquitetura em
 * que foi compilado. O nome carrega a arquitetura para que as duas copias
 * caibam lado a lado, e para que empacotar x64 sem ter gerado a copia falhe na
 * subida em vez de instalar um aplicativo que nao abre.
 */
const archFlag = process.argv.indexOf("--arch");
const arch = archFlag < 0 ? process.arch : process.argv[archFlag + 1];
const bindingTarget = join(appDir, "native", `better_sqlite3-electron-${arch}.node`);

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
  run("npx", ["electron-rebuild", "-f", "-w", "better-sqlite3", "--arch", arch]);
  copyFileSync(bindingSource, bindingTarget);
  run("npm", ["rebuild", "better-sqlite3"]);
}

ensureElectronBinding();

/**
 * As migracoes viajam como arquivo, ao lado do bundle.
 *
 * O migrator do drizzle le os `.sql` do disco na hora de rodar, entao embutir
 * a pasta no pacote do esbuild nao adiantaria. Copiar para `dist/` faz o
 * caminho ser o mesmo rodando por `npx electron dist/main.cjs` e dentro do
 * `.app`, onde `dist/` inteiro entra como recurso.
 */
function copyMigrations() {
  const source = join(appDir, "drizzle");
  if (!existsSync(join(source, "meta", "_journal.json"))) {
    throw new Error("nao achei app/drizzle, rode npm run db:generate");
  }
  const target = join(appDir, "dist", "drizzle");
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

copyMigrations();

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
