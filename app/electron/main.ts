import { app, BrowserWindow } from "electron";
import { join } from "node:path";

const smoke = process.argv.includes("--smoke");

// O nucleo abre o banco no import do modulo, entao o caminho do binding nativo
// precisa estar no ambiente antes de qualquer import dele. Por isso o acesso ao
// banco mora num import dinamico la embaixo, e nao no topo do arquivo.
process.env.LOCUM_SQLITE_BINDING = join(
  __dirname,
  "..",
  "native",
  "better_sqlite3-electron.node",
);

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

/** Confere que o nucleo carrega e que o banco responde a uma consulta. */
async function checkCore(): Promise<number> {
  const { db, schema } = await import("../src/db/index.js");
  const rows = await db.select().from(schema.agents);
  return rows.length;
}

async function main(): Promise<void> {
  await app.whenReady();

  if (smoke) {
    // Sem dock e sem janela: o loop de verificacao roda sem ninguem olhando, e
    // uma janela aberta travaria a iteracao esperando um clique.
    app.dock?.hide();
    const agents = await checkCore();
    console.log(`smoke ok: banco abriu, ${agents} agent(s) cadastrado(s)`);
    app.exit(0);
    return;
  }

  mainWindow = createWindow();

  app.on("activate", () => {
    if (mainWindow === null) mainWindow = createWindow();
  });
}

app.on("window-all-closed", () => {
  // No macOS o padrao e o app seguir vivo sem janela, e o Locum depende disso:
  // ele existe para vigiar em segundo plano.
  if (process.platform !== "darwin") app.quit();
});

main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
