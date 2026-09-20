import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const smoke = process.argv.includes("--smoke");

/** `--set-secret <ref>` e `--remove-secret <ref>`, com o valor vindo do stdin. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

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

/**
 * Prova que os ouvintes de energia estao no ar e que um resume chega ao
 * agendador. A batida de verdade nao entra: ela criaria run, e o smoke roda
 * sozinho no loop de verificacao, onde gastar assinatura por engano nao tem
 * quem perceba. Por isso o `onWake` aqui so conta.
 */
async function checkPower(): Promise<string> {
  const { emitPowerEvent, powerListenerCount, setupPower, teardownPower } = await import(
    "./power.js"
  );

  const before = powerListenerCount();
  const beats: (number | null)[] = [];
  let clock = Date.parse("2026-09-19T01:00:00Z");

  setupPower({ onWake: (slept) => void beats.push(slept), now: () => clock });

  const after = powerListenerCount();
  if (after.suspend !== before.suspend + 1 || after.resume !== before.resume + 1) {
    throw new Error("ouvintes de energia nao ficaram registrados");
  }

  const sleep = 90 * 60_000;
  emitPowerEvent("suspend");
  clock += sleep;
  emitPowerEvent("resume");

  if (beats.length !== 1) {
    throw new Error(`um resume bateu no agendador ${beats.length} vez(es)`);
  }
  if (beats[0] !== sleep) {
    throw new Error(`resume mediu ${String(beats[0])}ms de sono e o esperado era ${sleep}ms`);
  }

  teardownPower();
  const cleaned = powerListenerCount();
  if (cleaned.suspend !== before.suspend || cleaned.resume !== before.resume) {
    throw new Error("ouvinte de energia sobrou depois do teardown");
  }

  return "suspend e resume registrados, uma batida depois de 90min de sono";
}

/**
 * Prova que o segredo vai e volta pelo keychain, que o que fica no disco esta
 * cifrado, e que o cadastro guarda so a referencia.
 *
 * O segredo de teste e sorteado na hora e apagado no fim, e o servidor MCP de
 * mentira que serve de alvo tambem: o smoke roda no banco de verdade de quem
 * desenvolve e nao pode deixar cadastro para tras.
 */
async function checkSecrets(): Promise<string> {
  const { installSecretBackend } = await import("./safe-storage.js");
  const { secretService } = await import("../src/services/secret-service.js");
  const { McpService } = await import("../src/services/mcp-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const ref = `provider/locum-smoke-${randomUUID().slice(0, 8)}`;
  const segredo = `valor-de-teste-${randomUUID()}`;

  secretService.set(ref, segredo);
  if (secretService.get(ref) !== segredo) throw new Error("segredo nao voltou do keychain");
  if (readFileSync(secretService.pathFor(ref)).includes(segredo)) {
    throw new Error("o cofre gravou o segredo em claro");
  }

  // Caminho inteiro: cadastro com marcador, referencia no banco, segredo so na
  // configuracao que sobe o processo.
  const mcp = new McpService();
  const nome = `locum-smoke-${randomUUID().slice(0, 8)}`;
  try {
    await mcp.register({ name: nome, transport: "stdio", command: ["true"], env: { TOKEN: "${credential}" } });
    await mcp.setCredentialRef(nome, ref);

    const cadastro = await mcp.get(nome);
    if (cadastro?.config.env?.TOKEN !== "${credential}") {
      throw new Error("o cadastro deixou de guardar o marcador");
    }
    if (cadastro.credentialRef !== ref) throw new Error("a referencia nao ficou no banco");

    const paraConectar = (await mcp.enabledConfigs()).find((c) => c.name === nome);
    if (paraConectar?.env?.TOKEN !== segredo) {
      throw new Error("o segredo nao chegou na configuracao de conexao");
    }
  } finally {
    await mcp.remove(nome);
    secretService.remove(ref);
  }

  if (secretService.get(ref) !== undefined) throw new Error("segredo sobreviveu ao remove");
  return "segredo cifrado no disco, referencia no banco, valor so na conexao";
}

/** Quantas pendencias a fila tem, lida direto do servico. */
async function countPending(): Promise<number> {
  const { approvalService } = await import("../src/services/approval-service.js");
  return (await approvalService.listPending()).length;
}

/**
 * Guarda ou apaga um segredo e sai, sem janela e sem bandeja.
 *
 * Enquanto nao existe interface, e o unico jeito de por uma chave no keychain,
 * porque o `safeStorage` so existe dentro do Electron. O valor entra pelo
 * stdin, nunca por argumento: argumento aparece na lista de processos.
 */
async function runSecretCommand(): Promise<void> {
  const { installSecretBackend } = await import("./safe-storage.js");
  const { secretService } = await import("../src/services/secret-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const removeRef = flagValue("--remove-secret");
  if (removeRef !== undefined) {
    console.log(secretService.remove(removeRef) ? `${removeRef} apagado` : `${removeRef} nao existia`);
    return;
  }

  const ref = flagValue("--set-secret");
  if (ref === undefined) throw new Error("uso: --set-secret <escopo/nome>, com o valor no stdin");

  const pedacos: Buffer[] = [];
  for await (const pedaco of process.stdin) pedacos.push(pedaco as Buffer);
  const secret = Buffer.concat(pedacos).toString("utf8").trim();
  if (secret.length === 0) throw new Error("nada chegou pelo stdin");

  secretService.set(ref, secret);
  console.log(`${ref} guardado no keychain`);
}

async function main(): Promise<void> {
  await app.whenReady();

  if (flagValue("--set-secret") !== undefined || flagValue("--remove-secret") !== undefined) {
    await runSecretCommand();
    app.exit(0);
    return;
  }

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

    const power = await checkPower();
    const secrets = await checkSecrets();

    console.log(
      `smoke ok: banco abriu, ${agents} agent(s) cadastrado(s), ` +
        `bandeja criada com ${pending} pendencia(s), inicio no login com ${loginItem}, ` +
        `energia com ${power}, keychain com ${secrets}`,
    );
    app.exit(0);
    return;
  }

  // Antes da bandeja e do agendador: qualquer coisa que monte executor precisa
  // do cofre ja ligado para achar a credencial no keychain.
  const { installSecretBackend } = await import("./safe-storage.js");
  if (!installSecretBackend()) {
    console.log("keychain indisponivel, credenciais vem so do ambiente");
  }

  const { applyPreference } = await import("./login-item.js");
  const startup = await applyPreference();
  if (startup.preference !== null) {
    console.log(`inicio no login: preferencia ${startup.preference}, sistema ${startup.status}`);
  }

  await setupTray({ openWindow: showWindow });

  const { setupPower } = await import("./power.js");
  setupPower();

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
