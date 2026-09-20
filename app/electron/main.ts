import { app, BrowserWindow } from "electron";
import { captureDeepLinks } from "./deep-link.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

// Antes de qualquer espera: com o app fechado, o macOS sobe o processo para
// entregar a URL, e o `open-url` sai logo no lancamento. Ouvinte registrado
// depois do `whenReady` chega tarde e perde justamente a URL que subiu o app.
captureDeepLinks({ singleInstance: !smoke });

let mainWindow: BrowserWindow | null = null;

/** O preload sai do mesmo build que o main e fica ao lado dele em dist/. */
const PRELOAD = join(__dirname, "preload.cjs");

/**
 * A pagina que o Vite constroi, carregada do disco por `file://`.
 *
 * Nao existe servidor por tras da janela, e nem precisa: o Electron deixa o
 * modulo ES da pagina carregar em `file://`, ao contrario do Chrome de mesa,
 * que recusaria por origem opaca. Por isso o `base` do Vite e relativo, e por
 * isso nenhum recurso da pagina pode vir da rede.
 */
const RENDERER = join(__dirname, "renderer", "index.html");

function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: PRELOAD,
      // A janela nao tem Node nenhum. Tudo que ela alcanca do sistema passa
      // pelos canais do preload, e `sandbox` garante que nem um import solto
      // no renderer devolva `require`.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (options.show !== false) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

/**
 * Cria a janela do Locum: ponte confiada e pagina construida carregada.
 *
 * O `trustWindow` vem antes do `loadFile` de proposito. O preload roda assim
 * que o documento carrega, e um canal chamado por janela ainda nao confiada
 * volta como recusa para o renderer.
 */
async function openMainWindow(): Promise<BrowserWindow> {
  const { trustWindow } = await import("./bridge.js");

  const window = createWindow();
  trustWindow(window);
  await window.loadFile(RENDERER);
  mainWindow = window;
  return window;
}

/**
 * Abrir a janela leva alguns passos assincronos, e nesse meio tempo
 * `mainWindow` continua nulo. Sem guardar a abertura em curso, um clique na
 * bandeja junto de um clique numa notificacao abriria duas janelas.
 */
let opening: Promise<BrowserWindow> | null = null;

function ensureWindow(): Promise<BrowserWindow> {
  if (mainWindow !== null) return Promise.resolve(mainWindow);
  opening ??= openMainWindow().finally(() => {
    opening = null;
  });
  return opening;
}

/** Traz a janela para frente, criando uma se nao houver. */
function showWindow(): void {
  void ensureWindow().then((window) => {
    window.show();
    window.focus();
  });
}

/**
 * Clique na notificacao: janela na frente, apontada para o run que a gerou.
 *
 * Enquanto a interface nao existe, o destino fica so guardado e no log. A
 * janela ainda nao carrega nada, entao encaminhar a rota agora seria mandar
 * recado para ninguem; quando o renderer entrar, ele le daqui na subida.
 */
let inboxTarget: string | null = null;

function openInbox(runId: string): void {
  inboxTarget = runId;
  console.log(`notificacao: abrir a inbox no run ${runId}`);
  showWindow();
}

/** O ultimo run para onde um clique de notificacao mandou. */
export function pendingInboxTarget(): string | null {
  return inboxTarget;
}

/**
 * O que fazer com uma `locum://` vinda do sistema.
 *
 * A leitura e a regra moram no servico; aqui so sobra dizer ao usuario o que
 * aconteceu e trazer a janela de volta, que e o fim natural de um retorno de
 * navegador. Nem o codigo nem o token aparecem no log.
 */
async function handleDeepLink(url: string): Promise<void> {
  const { deepLinkService, parseDeepLink } = await import("../src/services/deep-link-service.js");

  const route = parseDeepLink(url);
  if (route.kind === "unknown") {
    console.log(`deep link: url descartada, ${route.reason}`);
    return;
  }
  if (route.kind === "oauth-error") {
    deepLinkService.cancelAuthorization(route.server);
    console.log(`deep link: autorizacao de ${route.server} recusada, ${route.error}`);
    return;
  }

  const result = await deepLinkService.completeOAuth(route);
  console.log(
    `deep link: ${result.server} autorizado, credencial em ${result.credentialRef}` +
      (result.hasRefresh ? ", com refresh guardado" : ""),
  );
  showWindow();
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

/**
 * Prova que o aviso nativo monta com o run certo e que ele agrupa por run.
 *
 * Nada e mostrado: `show()` nao entra aqui. O smoke roda no loop de
 * verificacao, sem ninguem olhando, e alerta na tela de quem estiver usando a
 * maquina nao e coisa que um teste possa fazer. O clique e simulado no proprio
 * emissor de eventos da notificacao, que e o que prova o destino.
 */
async function checkNotifications(): Promise<string> {
  const { buildNotification, notificationsShown, setupNotifications, teardownNotifications } =
    await import("./notify.js");
  const { criticalNotices } = await import("../src/services/notice-service.js");

  const runId = `run-smoke-${randomUUID().slice(0, 8)}`;
  const critico = { severity: "critical", problem: "leitura fora do limite do vetor" };

  // Duas pendencias do mesmo run, com tres criticos no total: um aviso so.
  const notices = criticalNotices([
    {
      runId,
      agentName: "pr-review",
      createdAt: 1_760_000_000,
      payload: { findings: [critico, { severity: "low", problem: "nome confuso" }] },
    },
    {
      runId,
      agentName: "pr-review",
      createdAt: 1_760_000_060,
      payload: { findings: [critico, critico] },
    },
    { runId: `${runId}-outro`, agentName: "pr-review", createdAt: 1, payload: { findings: [] } },
  ]);

  if (notices.length !== 1) {
    throw new Error(`o mesmo run virou ${notices.length} aviso(s) em vez de um`);
  }
  const [notice] = notices;
  if (notice === undefined) throw new Error("agrupamento nao devolveu aviso");
  if (notice.runId !== runId) throw new Error("o aviso aponta para outro run");
  if (notice.criticalCount !== 3) {
    throw new Error(`o aviso contou ${notice.criticalCount} criticos e o esperado era 3`);
  }
  if (notice.at !== 1_760_000_060) throw new Error("o aviso nao pegou a pendencia mais nova");

  const cliques: string[] = [];
  await setupNotifications({ openInbox: (id) => void cliques.push(id) });

  buildNotification(notice).emit("click");
  if (cliques.length !== 1 || cliques[0] !== runId) {
    throw new Error(`o clique mandou para ${JSON.stringify(cliques)} em vez de ${runId}`);
  }
  if (notificationsShown() !== 0) {
    throw new Error("o smoke mostrou notificacao na tela");
  }
  teardownNotifications();

  return "aviso montado sem exibir, tres criticos num run so, clique aponta para o run";
}

/**
 * Prova que o esquema `locum://` chega ao tratador e que o token que vem de um
 * retorno de OAuth termina no cofre, com o cadastro guardando so a referencia.
 *
 * A troca do codigo pelo token e de mentira: nao ha servidor de autorizacao
 * para conversar, e o smoke roda sozinho no loop de verificacao, onde chamada
 * de rede so traria intermitencia. O que esta sendo provado e o caminho de
 * dentro, do `open-url` ate o `credential_ref`.
 *
 * O cadastro e o segredo de teste sao sorteados na hora e apagados no fim: o
 * smoke roda no banco de verdade de quem desenvolve.
 */
async function checkDeepLink(): Promise<string> {
  const { emitDeepLink, registerProtocol, setupDeepLink, teardownDeepLink } = await import(
    "./deep-link.js"
  );
  const { installSecretBackend } = await import("./safe-storage.js");
  const { DeepLinkService, parseDeepLink, OAUTH_REDIRECT_URI } = await import(
    "../src/services/deep-link-service.js"
  );
  const { McpService } = await import("../src/services/mcp-service.js");
  const { secretService } = await import("../src/services/secret-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const protocolo = await registerProtocol();
  if (protocolo.scheme !== "locum") throw new Error("o esquema registrado nao e locum");

  const mcp = new McpService();
  const deepLink = new DeepLinkService(mcp);
  const nome = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const token = `token-de-teste-${randomUUID()}`;

  const rotas: string[] = [];
  const falhas: string[] = [];
  setupDeepLink(async (url) => {
    const rota = parseDeepLink(url);
    rotas.push(rota.kind);
    if (rota.kind !== "oauth-callback") return;
    try {
      await deepLink.completeOAuth(rota, () => Promise.resolve({ accessToken: token }));
    } catch (error: unknown) {
      falhas.push(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mcp.register({
      name: nome,
      transport: "http",
      url: "https://exemplo.invalido/mcp",
      headers: { Authorization: "${credential}" },
    });

    const pedido = await deepLink.beginAuthorization({
      server: nome,
      authorizeUrl: "https://exemplo.invalido/authorize",
      tokenUrl: "https://exemplo.invalido/token",
      clientId: "locum-smoke",
    });
    const autorizacao = new URL(pedido.url);
    if (autorizacao.searchParams.get("code_challenge_method") !== "S256") {
      throw new Error("o pedido de autorizacao saiu sem PKCE");
    }
    if (autorizacao.searchParams.get("redirect_uri") !== `${OAUTH_REDIRECT_URI}?server=${nome}`) {
      throw new Error("o pedido de autorizacao aponta para outro retorno");
    }
    if (!deepLink.isAwaitingCallback(nome)) throw new Error("a autorizacao nao ficou pendente");

    // URL de fora, que nao e do Locum: cai como desconhecida e nao mexe em nada.
    emitDeepLink("https://exemplo.invalido/nao-e-nosso");
    const retorno = `locum://oauth/callback?server=${nome}&code=codigo-de-teste&state=${encodeURIComponent(pedido.state)}`;
    emitDeepLink(retorno);
    // O tratador e assincrono e o emissor do Electron nao espera por ele.
    await new Promise((resolve) => setImmediate(resolve));

    if (falhas.length > 0) throw new Error(`o retorno falhou: ${falhas.join(", ")}`);
    if (rotas.join(",") !== "unknown,oauth-callback") {
      throw new Error(`as rotas vistas foram ${JSON.stringify(rotas)}`);
    }

    const cadastro = await mcp.get(nome);
    if (cadastro?.credentialRef !== `mcp/${nome}`) {
      throw new Error("a referencia da credencial nao ficou no cadastro");
    }
    if (cadastro.config.headers?.Authorization !== "${credential}") {
      throw new Error("o cadastro deixou de guardar o marcador");
    }

    const paraConectar = (await mcp.enabledConfigs()).find((c) => c.name === nome);
    if (paraConectar?.headers?.Authorization !== `Bearer ${token}`) {
      throw new Error("o token nao chegou no cabecalho da conexao");
    }
    if (readFileSync(secretService.pathFor(`mcp/${nome}`)).includes(token)) {
      throw new Error("o cofre gravou o token em claro");
    }

    // Retorno repetido com o mesmo state: o pendente ja foi consumido.
    emitDeepLink(retorno);
    await new Promise((resolve) => setImmediate(resolve));
    if (falhas.length !== 1 || !falhas[0]?.includes("nenhuma autorizacao pendente")) {
      throw new Error(`o state usado duas vezes nao foi recusado: ${JSON.stringify(falhas)}`);
    }
  } finally {
    teardownDeepLink();
    await mcp.remove(nome);
    deepLink.cancelAuthorization(nome);
    secretService.remove(`mcp/${nome}`);
  }

  return (
    `esquema locum ${protocolo.registered ? "registrado" : "nao aceito fora de app empacotado"}, ` +
    "retorno de OAuth roteado, token no cofre e referencia no cadastro"
  );
}

/**
 * Prova que a janela fala com os servicos pela ponte, e so por ela.
 *
 * A janela sobe com `show: false` e carrega `about:blank`, que e o minimo para
 * o preload rodar: preload so executa quando um documento carrega, entao
 * conferir o arquivo no disco nao provaria nada. Nada aparece na tela, que e o
 * que o smoke exige.
 *
 * O que esta sendo provado e o caminho inteiro: o preload expoe a ponte, o
 * canal atravessa o IPC, o servico responde, e o valor que volta bate com o
 * que o mesmo servico devolve deste lado.
 */
async function checkBridge(): Promise<string> {
  const { bridgeChannelCount, setupBridge, teardownBridge, trustWindow } = await import(
    "./bridge.js"
  );
  const { BRIDGE_GLOBAL } = await import("./bridge-contract.js");
  const { agentService } = await import("../src/services/agent-service.js");

  if (!existsSync(PRELOAD)) throw new Error(`preload nao foi construido em ${PRELOAD}`);

  const canais = setupBridge({ inboxTarget: pendingInboxTarget });
  if (canais !== bridgeChannelCount()) throw new Error("canal registrado a menos");

  const window = createWindow({ show: false });
  trustWindow(window);

  try {
    await window.loadURL("about:blank");

    const visto = (await window.webContents.executeJavaScript(
      `({
        ponte: typeof globalThis.${BRIDGE_GLOBAL},
        agentes: typeof globalThis.${BRIDGE_GLOBAL}?.agents?.list,
        decidir: typeof globalThis.${BRIDGE_GLOBAL}?.approvals?.decide,
        require: typeof globalThis.require,
        process: typeof globalThis.process,
      })`,
    )) as Record<string, string>;

    if (visto["ponte"] !== "object") throw new Error("o preload nao pendurou a ponte na janela");
    if (visto["agentes"] !== "function") throw new Error("a ponte subiu sem os canais");
    if (visto["decidir"] !== "function") throw new Error("a inbox ficou sem o canal de decisao");
    if (visto["require"] !== "undefined" || visto["process"] !== "undefined") {
      throw new Error("a janela enxerga Node, nodeIntegration ou sandbox saiu do lugar");
    }

    const daPonte = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.agents.list().then((a) => a.map((x) => x.id))`,
    )) as string[];
    const doServico = (await agentService.list()).map((a) => a.id);
    if (daPonte.join(",") !== doServico.join(",")) {
      throw new Error("a lista que veio pela ponte nao bate com a do servico");
    }

    const pendentes = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.approvals.listPending().then((p) => p.length)`,
    )) as number;
    if (pendentes !== (await countPending())) {
      throw new Error("a fila vista pela ponte nao bate com a do servico");
    }

    // Decisao sobre pendencia que nao existe: a gate recusa, e e ela quem
    // recusa. A ponte nao tem o que dizer sobre publicar. O Electron registra
    // sozinho todo erro de handler de IPC, entao a recusa esperada vai aparecer
    // no log logo abaixo: e o teste passando, nao o smoke quebrando.
    console.log("ponte: a proxima linha de erro e a recusa esperada da gate");
    const recusa = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.approvals.decide("nao-existe", "approved").then(() => "passou", (e) => String(e.message))`,
    )) as string;
    if (!recusa.includes("nao encontrada")) {
      throw new Error(`decisao sobre pendencia inexistente devolveu ${recusa}`);
    }
  } finally {
    window.destroy();
    teardownBridge();
  }

  return `${canais} canais no ar, janela sem Node, valores batendo com os servicos`;
}

/**
 * Prova que a pagina construida sobe dentro da janela.
 *
 * A janela nasce com `show: false` e nada aparece na tela: o smoke roda no
 * loop de verificacao, sem ninguem olhando. Quem responde e o proprio
 * renderer, por `executeJavaScript`, que e a unica forma de saber se o React
 * montou de verdade. Conferir o `index.html` no disco nao provaria nada.
 *
 * Alem da raiz, a folha do Tailwind e conferida pelo marcador `hidden` da
 * pagina: raiz montada prova o React, nao prova que o CSS chegou. E o console
 * do renderer entra no exame porque modulo que falha ao carregar deixa a raiz
 * vazia sem estourar deste lado.
 *
 * O bloco de codigo tambem entra, e ele so fica pronto depois da pagina: o
 * shiki destaca de forma assincrona e busca a gramatica da linguagem num
 * pedaco separado do pacote. Por isso a espera abaixo, que e o unico jeito de
 * saber que o import dinamico funciona carregando do disco, sem servidor.
 *
 * E a ponte sobe junto, porque a pagina agora le pelos canais assim que monta.
 * O `checkBridge` prova o caminho com `about:blank` e chamada solta; aqui o que
 * esta sendo provado e a pagina de verdade lendo por conta propria, com o hook
 * no meio, e os valores que ela exibiu conferidos contra os mesmos servicos.
 *
 * A navegacao entre os quatro destinos entra pelo mesmo caminho do clique, que
 * e escrever o hash, porque o loop roda sem ninguem olhando e nao ha clique
 * para dar.
 */
async function checkRenderer(): Promise<string> {
  if (!existsSync(RENDERER)) throw new Error(`renderer nao foi construido em ${RENDERER}`);

  const { setupBridge, teardownBridge, trustWindow } = await import("./bridge.js");
  const { agentService } = await import("../src/services/agent-service.js");
  const { runService } = await import("../src/services/run-service.js");
  const { ensureDemoRun } = await import("../src/fixtures/demo-run.js");

  // Banco vazio faz a tela de execucoes passar sem provar nada: lista vazia e
  // detalhe inexistente batem com servico vazio por acidente. O fixture planta
  // uma execucao pronta, e nao roda o pipeline, que custaria minutos de
  // assinatura a cada verificacao do loop.
  const fixture = await ensureDemoRun();

  setupBridge({ inboxTarget: pendingInboxTarget });

  const window = createWindow({ show: false });
  trustWindow(window);
  const erros: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") erros.push(event.message);
  });

  try {
    await window.loadFile(RENDERER);

    const visto = (await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.querySelector("[data-locum-probe=tailwind]");
        return {
          raiz: document.getElementById("root")?.childElementCount ?? 0,
          marca: document.querySelector("[data-locum-probe=marca]")?.textContent ?? "",
          folha: probe === null ? "sem marcador" : getComputedStyle(probe).display,
        };
      })()`,
    )) as { raiz: number; marca: string; folha: string };

    if (erros.length > 0) throw new Error(`o renderer registrou erro: ${erros.join(", ")}`);
    if (visto.raiz === 0) throw new Error("a raiz #root ficou vazia, o React nao montou");
    if (visto.marca !== "Locum") throw new Error(`a barra lateral montou com a marca ${visto.marca}`);
    if (visto.folha !== "none") {
      throw new Error(`o marcador do Tailwind ficou com display ${visto.folha} em vez de none`);
    }

    const rotas = await checkRoutes(window);
    const paleta = await checkPalette(window);

    const execucoes = await checkRuns(window, fixture);
    // O bloco de codigo mora no detalhe de uma execucao, que e quem vai usa-lo
    // de verdade: a saida de cada passo sai como JSON destacado. O `checkRuns`
    // deixa a janela nesse detalhe, entao o destaque e conferido de onde ele
    // aparece.
    const destacado = await esperarDestaque(window);
    const ponte = await esperarPonte(window);

    const agentes = (await agentService.list()).map((a) => a.id).join(",");
    if (ponte.agents !== agentes) {
      throw new Error(`a janela leu os agents ${ponte.agents} e o servico tem ${agentes}`);
    }
    const total = (await runService.list()).length;
    if (ponte.runs !== total) {
      throw new Error(`a janela leu ${ponte.runs} execucao(oes) e o servico tem ${total}`);
    }
    const pendencias = await countPending();
    if (ponte.pendencias !== pendencias) {
      throw new Error(`a janela leu ${ponte.pendencias} pendencia(s) e a fila tem ${pendencias}`);
    }

    if (erros.length > 0) throw new Error(`o renderer registrou erro: ${erros.join(", ")}`);

    return (
      "pagina construida carregada, raiz montada, folha do Tailwind valendo, " +
      `${rotas} navegando, ${paleta}, ${execucoes}, ` +
      `bloco de codigo com ${destacado} trecho(s) destacado(s) e a janela lendo ` +
      `${ponte.runs} execucao(oes) e ${ponte.pendencias} pendencia(s) pela ponte`
    );
  } finally {
    window.destroy();
    teardownBridge();
  }
}

/**
 * Espera as leituras da pagina terminarem e devolve o que ela exibiu.
 *
 * A pagina monta antes de a ponte responder, entao conferir logo depois do
 * `loadFile` pegaria o estado de carregando. O marcador guarda o estado junto
 * dos valores justamente para que a espera saiba a hora, em vez de dormir um
 * tempo arbitrario e torcer.
 */
async function esperarPonte(
  window: BrowserWindow,
): Promise<{ agents: string; runs: number; pendencias: number }> {
  const limite = Date.now() + 20_000;
  let ultimo = "sem marcador";

  while (Date.now() < limite) {
    const visto = (await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.querySelector("[data-locum-probe=ponte]");
        if (probe === null) return null;
        return {
          estado: probe.dataset.estado,
          erro: probe.dataset.erro,
          agents: probe.dataset.agents,
          runs: Number(probe.dataset.runs),
          pendencias: Number(probe.dataset.pendencias),
        };
      })()`,
    )) as { estado: string; erro: string; agents: string; runs: number; pendencias: number } | null;

    if (visto !== null) {
      if (visto.estado === "erro") throw new Error(`a janela nao leu pela ponte: ${visto.erro}`);
      if (visto.estado === "pronto") return visto;
      ultimo = visto.estado;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`as leituras da janela ficaram em "${ultimo}" por 20s`);
}

/**
 * Poe a janela num destino e espera a tela trocar.
 *
 * A navegacao e por hash porque nao existe servidor atras da pagina, e escrever
 * o hash e exatamente o que o clique na barra lateral faz: o caminho exercitado
 * aqui e o mesmo que uma pessoa usa.
 */
async function irPara(window: BrowserWindow, id: string, detalhe?: string): Promise<void> {
  const cauda = detalhe === undefined ? "" : `/${encodeURIComponent(detalhe)}`;
  const esperado = `${id}|${detalhe ?? ""}`;
  await window.webContents.executeJavaScript(`(location.hash = "#/${id}${cauda}", null)`);

  const limite = Date.now() + 10_000;
  let ultimo = "sem marcador";

  while (Date.now() < limite) {
    const onde = (await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.querySelector("[data-locum-probe=rota]");
        return probe === null ? null : probe.dataset.ativo + "|" + probe.dataset.detalhe;
      })()`,
    )) as string | null;

    if (onde === esperado) return;
    if (onde !== null) ultimo = onde;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`a janela ficou em "${ultimo}" depois de pedir o destino ${esperado}`);
}

/**
 * Confere os quatro destinos e que navegar entre eles troca a tela.
 *
 * Os identificadores e os titulos saem da propria barra lateral, e nao de uma
 * copia deste lado: uma lista repetida aqui passaria a concordar com ela mesma
 * no dia em que o catalogo do renderer mudasse. O que fica escrito deste lado e
 * so a exigencia da story, que sao estes quatro destinos.
 */
async function checkRoutes(window: BrowserWindow): Promise<string> {
  const esperados = ["inbox", "execucoes", "agents", "configuracao"];

  const barra = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-rota]")).map((b) => ({
      id: b.dataset.locumRota,
      titulo: b.querySelector("span")?.textContent ?? "",
    }))`,
  )) as { id: string; titulo: string }[];

  const ids = barra.map((r) => r.id);
  if (ids.join(",") !== esperados.join(",")) {
    throw new Error(`a barra lateral oferece ${ids.join(",")} e nao ${esperados.join(",")}`);
  }

  const inicial = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=rota]")?.dataset.ativo ?? null`,
  )) as string | null;
  if (inicial !== esperados[0]) {
    throw new Error(`com o hash vazio a janela abriu em ${inicial} e nao em ${esperados[0]}`);
  }

  for (const { id, titulo } of barra) {
    await irPara(window, id);

    const visto = (await window.webContents.executeJavaScript(
      `(() => ({
        titulo: document.querySelector("h1")?.textContent ?? "",
        marcado: document.querySelector("[data-locum-rota][aria-current=page]")?.dataset.locumRota ?? null,
      }))()`,
    )) as { titulo: string; marcado: string | null };

    if (visto.titulo !== titulo) {
      throw new Error(`o destino ${id} mostrou o titulo ${visto.titulo} e nao ${titulo}`);
    }
    if (visto.marcado !== id) {
      throw new Error(`o destino ${id} esta ativo e a barra marca ${visto.marcado}`);
    }
  }

  // Um destino desconhecido nao pode deixar a janela em branco: quem chegar por
  // hash velho, ou por deep link de uma versao anterior, cai no padrao.
  await irPara(window, esperados[0] as string);
  await window.webContents.executeJavaScript(`(location.hash = "#/nao-existe", null)`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const desconhecido = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=rota]")?.dataset.ativo ?? null`,
  )) as string | null;
  if (desconhecido !== esperados[0]) {
    throw new Error(`hash desconhecido levou a janela para ${desconhecido}`);
  }

  return `${barra.length} destino(s)`;
}

/**
 * Confere que o atalho abre a paleta de comandos e que Escape a fecha.
 *
 * Ela ainda nao tem comando nenhum dentro, entao o que esta sendo provado e o
 * atalho: o ouvinte de teclado esta no ar e o estado da paleta responde a ele.
 */
async function checkPalette(window: BrowserWindow): Promise<string> {
  const estado = async (): Promise<string | null> =>
    (await window.webContents.executeJavaScript(
      `document.querySelector("[data-locum-probe=paleta]")?.dataset.aberta ?? null`,
    )) as string | null;

  const tecla = async (script: string): Promise<void> => {
    await window.webContents.executeJavaScript(script);
    // O estado e do React, que pinta no proximo quadro: perguntar na mesma
    // linha pegaria o valor anterior.
    await new Promise((resolve) => setTimeout(resolve, 200));
  };

  if ((await estado()) !== "nao") throw new Error("a paleta nasceu aberta");

  await tecla(
    `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })), null)`,
  );
  if ((await estado()) !== "sim") throw new Error("o atalho nao abriu a paleta de comandos");

  await tecla(
    `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), null)`,
  );
  if ((await estado()) !== "nao") throw new Error("Escape nao fechou a paleta de comandos");

  return "paleta abrindo e fechando pelo atalho";
}

/**
 * Confere a lista de execucoes e o detalhe de uma delas.
 *
 * Os dois lados sao comparados contra o mesmo servico, e nao contra numeros
 * escritos aqui: o que o loop precisa saber e se a janela mostra o que o banco
 * tem, nao se alguem lembrou de atualizar uma constante deste lado.
 *
 * O botao de reexecutar e conferido por existir, e nunca clicado. Clicar
 * soltaria o executor de verdade, que gasta minutos de assinatura e leva o run
 * junto: o que esta sendo provado aqui e a fiacao, e um passo por botao.
 *
 * Ao sair, a janela fica no detalhe, porque e la que vive o bloco de codigo
 * que a verificacao do destaque procura.
 */
async function checkRuns(window: BrowserWindow, runId: string): Promise<string> {
  const { runService } = await import("../src/services/run-service.js");

  await irPara(window, "execucoes");
  const lista = await esperarProbe<{ estado: string; runs: string; total: number }>(
    window,
    "execucoes",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=execucoes]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { estado: probe.dataset.estado, runs: probe.dataset.runs, total: Number(probe.dataset.total) };
    })()`,
  );

  const doServico = (await runService.list({ limit: 500 })).map((r) => r.id);
  if (lista.runs !== doServico.join(",")) {
    throw new Error(`a lista mostrou ${lista.runs} e o servico devolveu ${doServico.join(",")}`);
  }
  if (!doServico.includes(runId)) {
    throw new Error(`o run plantado ${runId} nao apareceu na lista`);
  }

  // A linha so existe no DOM se a janela virtual a desenhou: lista vazia de
  // linhas com o total certo passaria pela conferencia acima.
  const desenhadas = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-run]").length`,
  )) as number;
  if (desenhadas === 0) throw new Error("a lista de execucoes nao desenhou nenhuma linha");

  await irPara(window, "execucoes", runId);
  const detalhe = await esperarProbe<{ run: string; passos: number; chaves: string; achados: number }>(
    window,
    "execucao",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=execucao]");
      // Os passos e os achados sao duas leituras, e a segunda demora mais.
      // O menos um e o "ainda lendo" das duas, entao girar enquanto ele
      // aparecer e o que separa conferir o estado final de conferir o inicial.
      if (probe === null || probe.dataset.passos === "-1" || probe.dataset.achados === "-1") return null;
      return {
        run: probe.dataset.run,
        passos: Number(probe.dataset.passos),
        chaves: probe.dataset.chaves,
        achados: Number(probe.dataset.achados),
      };
    })()`,
  );

  const doBanco = await runService.get(runId);
  if (doBanco === undefined) throw new Error(`o run plantado ${runId} sumiu do banco`);

  const chaves = doBanco.spec.steps.map((p) => p.key);
  if (chaves.length !== 4) {
    throw new Error(`o agent semente passou a ter ${chaves.length} passos e o smoke espera quatro`);
  }
  if (detalhe.passos !== doBanco.steps.length) {
    throw new Error(`o detalhe mostrou ${detalhe.passos} passo(s) e o run tem ${doBanco.steps.length}`);
  }
  if (detalhe.chaves !== doBanco.steps.map((p) => p.stepKey).join(",")) {
    throw new Error(`o detalhe listou os passos ${detalhe.chaves}`);
  }

  const achados = (await runService.findings(runId)).length;
  if (detalhe.achados !== achados) {
    throw new Error(`o detalhe mostrou ${detalhe.achados} achado(s) e o servico tem ${achados}`);
  }

  const rerun = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-rerun]")).map((b) => b.dataset.locumRerun).join(",")`,
  )) as string;
  if (rerun !== detalhe.chaves) {
    throw new Error(`os botoes de reexecutar cobrem ${rerun} e os passos sao ${detalhe.chaves}`);
  }

  return (
    `lista com ${lista.total} execucao(oes) e ${desenhadas} linha(s) desenhada(s), ` +
    `detalhe de ${detalhe.passos} passo(s) com ${detalhe.achados} achado(s) e botao de reexecutar em cada`
  );
}

/** Gira ate o marcador responder com algo que nao seja nulo. */
async function esperarProbe<T>(
  window: BrowserWindow,
  nome: string,
  script: string,
): Promise<T> {
  const limite = Date.now() + 20_000;

  while (Date.now() < limite) {
    const visto = (await window.webContents.executeJavaScript(script)) as T | null;
    if (visto !== null) return visto;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`o marcador ${nome} nao ficou pronto dentro de 20s`);
}

/**
 * Espera o shiki terminar e devolve quantos trechos ele coloriu.
 *
 * O destaque nao esta no HTML construido: ele acontece no navegador, depois de
 * um import dinamico do pacote da linguagem. Contar `span` com cor e o que
 * separa "o componente montou" de "o destaque funcionou": sem a gramatica o
 * shiki ainda desenha o `pre`, so que com o codigo todo na mesma cor.
 */
async function esperarDestaque(window: BrowserWindow): Promise<number> {
  const limite = Date.now() + 20_000;

  while (Date.now() < limite) {
    const coloridos = (await window.webContents.executeJavaScript(
      `(() => {
        const bloco = document.querySelector("[data-locum-probe=code-block] pre.shiki");
        if (bloco === null) return 0;
        return bloco.querySelectorAll("span[style*='color']").length;
      })()`,
    )) as number;

    if (coloridos > 0) return coloridos;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("o bloco de codigo nao ficou destacado dentro de 20s");
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
    const avisos = await checkNotifications();
    const deepLink = await checkDeepLink();
    const ponte = await checkBridge();
    const renderer = await checkRenderer();

    console.log(
      `smoke ok: banco abriu, ${agents} agent(s) cadastrado(s), ` +
        `bandeja criada com ${pending} pendencia(s), inicio no login com ${loginItem}, ` +
        `energia com ${power}, keychain com ${secrets}, notificacao com ${avisos}, ` +
        `deep link com ${deepLink}, ponte com ${ponte}, interface com ${renderer}`,
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

  // Depois do cofre, porque o retorno de OAuth guarda token, e antes da janela,
  // para que a URL que subiu o app nao fique esperando na fila.
  const { registerProtocol, setupDeepLink } = await import("./deep-link.js");
  const protocolo = await registerProtocol();
  if (!protocolo.registered) {
    console.log("deep link: o sistema nao deu o esquema locum:// ao Locum, ver docs/estado-atual.md");
  }
  const esperando = setupDeepLink(handleDeepLink);
  if (esperando > 0) console.log(`deep link: ${esperando} url(s) esperavam desde a subida`);

  const { applyPreference } = await import("./login-item.js");
  const startup = await applyPreference();
  if (startup.preference !== null) {
    console.log(`inicio no login: preferencia ${startup.preference}, sistema ${startup.status}`);
  }

  await setupTray({ openWindow: showWindow });

  const { setupNotifications } = await import("./notify.js");
  const jaNaFila = await setupNotifications({ openInbox });
  if (jaNaFila > 0) console.log(`notificacao: ${jaNaFila} aviso(s) ja na fila, nenhum exibido`);

  const { setupPower } = await import("./power.js");
  setupPower();

  // Antes da janela: o preload chama os canais assim que o documento carrega, e
  // canal ainda nao registrado volta como erro de IPC para o renderer.
  const { setupBridge } = await import("./bridge.js");
  setupBridge({ inboxTarget: pendingInboxTarget });

  await ensureWindow();

  app.on("activate", showWindow);
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
