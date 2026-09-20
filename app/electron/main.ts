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

/** Traz a janela para frente, criando uma se nao houver. */
function showWindow(): void {
  if (mainWindow === null) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

/** Confere que o nucleo carrega e que o banco responde a uma consulta. */
async function checkCore(): Promise<number> {
  const { db, schema } = await import("../src/db/index.js");
  const rows = await db.select().from(schema.agents);
  return rows.length;
}

/**
 * Prova que a preferencia de subir no login vai e volta do banco e que o
 * sistema responde. A gravacao no sistema repete o estado que ja estava la de
 * proposito: o smoke roda na maquina de quem desenvolve e nao pode sair
 * ligando o Locum no login de ninguem.
 */
async function checkLoginItem(): Promise<string> {
  const { applyPreference, readLoginItem, writeLoginItem } = await import("./login-item.js");
  const { startupService } = await import("../src/services/startup-service.js");

  const before = await startupService.getPreference();
  for (const value of [true, false]) {
    await startupService.setPreference(value);
    if ((await startupService.getPreference()) !== value) {
      throw new Error(`preferencia ${value} nao voltou do banco`);
    }
  }
  if (before === null) await startupService.clearPreference();
  else await startupService.setPreference(before);

  const system = readLoginItem();
  const rewritten = writeLoginItem(system.openAtLogin);
  if (rewritten.openAtLogin !== system.openAtLogin) {
    throw new Error("regravar o mesmo estado mudou o item de login");
  }

  const state = await applyPreference();
  const decision = state.preference === null ? "nao decidida" : String(state.preference);
  return `preferencia ${decision}, sistema ${state.status}`;
}

/** Quantas pendencias a fila tem, lida direto do servico. */
async function countPending(): Promise<number> {
  const { approvalService } = await import("../src/services/approval-service.js");
  return (await approvalService.listPending()).length;
}

async function main(): Promise<void> {
  await app.whenReady();

  // O nucleo abre o banco no import, entao tudo que fala com ele entra por
  // import dinamico, depois da variavel de ambiente do binding.
  const { setupTray, teardownTray, trayPendingCount } = await import("./tray.js");

  if (smoke) {
    // Sem dock e sem janela: o loop de verificacao roda sem ninguem olhando, e
    // uma janela aberta travaria a iteracao esperando um clique. A bandeja
    // continua valendo, porque ela nao pede clique de ninguem para existir.
    app.dock?.hide();
    const agents = await checkCore();

    const loginItem = await checkLoginItem();

    const tray = await setupTray({ openWindow: showWindow });
    const pending = await countPending();
    if (tray.isDestroyed()) throw new Error("bandeja nao sobreviveu a criacao");
    if (trayPendingCount() !== pending) {
      throw new Error(
        `bandeja marca ${trayPendingCount()} pendencia(s) e a fila tem ${pending}`,
      );
    }
    teardownTray();

    console.log(
      `smoke ok: banco abriu, ${agents} agent(s) cadastrado(s), ` +
        `bandeja criada com ${pending} pendencia(s), inicio no login com ${loginItem}`,
    );
    app.exit(0);
    return;
  }

  const { applyPreference } = await import("./login-item.js");
  const startup = await applyPreference();
  if (startup.preference !== null) {
    console.log(`inicio no login: preferencia ${startup.preference}, sistema ${startup.status}`);
  }

  await setupTray({ openWindow: showWindow });
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
