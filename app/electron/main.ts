import { app, BrowserWindow } from "electron";
import { captureDeepLinks } from "./deep-link.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { aplicarIdioma, idiomaAtual, iniciarI18n, t } from "./i18n.js";
import en from "../locales/en.json";
import ptBR from "../locales/pt-BR.json";
import { join, sep } from "node:path";
// So tipo: o `import type` e apagado no build, e um import de valor vindo de
// `src/` aqui em cima carregaria o nucleo antes de `LOCUM_SQLITE_BINDING`
// apontar o binario do Electron.
import type { RunService } from "../src/services/run-service.js";
import type { AftermathFetcher } from "../src/services/reconcile-service.js";

const smoke = process.argv.includes("--smoke");
const capturas = process.argv.includes("--capturas");

/** `--set-secret <ref>` e `--remove-secret <ref>`, com o valor vindo do stdin. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/**
 * Tira um caminho de dentro do asar.
 *
 * Empacotado, `__dirname` cai dentro de `app.asar`, que e um arquivo so. Isso
 * basta para ler JSON e HTML, porque o Electron remenda o `fs`, mas nao para
 * modulo nativo: `dlopen` e do sistema e nao enxerga caminho la dentro. O que
 * o `asarUnpack` do empacotamento deixa em `app.asar.unpacked` sai por aqui.
 */
function foraDoAsar(caminho: string): string {
  return caminho.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

// O nucleo abre o banco no import do modulo, entao o caminho do binding nativo
// precisa estar no ambiente antes de qualquer import dele. Por isso o acesso ao
// banco mora num import dinamico la embaixo, e nao no topo do arquivo.
//
// O nome carrega a arquitetura porque o pacote sai para arm64 e x64, e um
// `.node` compilado para uma nao carrega na outra.
process.env.LOCUM_SQLITE_BINDING = foraDoAsar(
  join(__dirname, "..", "native", `better_sqlite3-electron-${process.arch}.node`),
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
    trafficLightPosition: { x: 14, y: 16 },
    // Sem material do sistema: a janela pinta as próprias superfícies. A
    // vibrancy deixava a barra lateral transparente, e onde ela não aparece o
    // texto some. Profundidade aqui vem de luminância, que não depende de
    // suporte de composição.
    backgroundColor: "#35383F",
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
  const decision =
    state.preference === null ? t("smoke.loginItemUndecided") : String(state.preference);
  return t("smoke.loginItem", { decision, status: state.status });
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

  return t("smoke.power", { minutes: sleep / 60_000 });
}


/** A conferência não varre: gatilho de varredura não chega a este agendador. */
const proibirVarredura = async (): Promise<string[]> => {
  throw new Error("o smoke da conferencia nao pode varrer o GitHub");
};
/**
 * Prova que a conferência de pull request fechado roda na batida do agendador,
 * e que ela não reprocessa quem já ganhou desfecho.
 *
 * Nada aqui fala com o GitHub: o leitor do que aconteceu depois do review entra
 * trocado, contando quantas vezes cada pull request foi visitado. É o que
 * permite exigir a parte difícil da story, que é uma afirmação sobre a segunda
 * batida: a execução fechada não pode ser visitada de novo, e a que ficou com o
 * pull request aberto tem que voltar.
 *
 * O agendador entra inteiro, com o serviço de gatilhos trocado por um que não
 * enxerga nada habilitado. Sem isso a batida dispararia o que estiver ligado no
 * banco de quem desenvolve, e o smoke gastaria assinatura sem ninguém pedir.
 *
 * As duas execuções são plantadas e apagadas aqui mesmo. O smoke roda no banco
 * de verdade, e evento de origem `github` que sobrevivesse entraria na fila de
 * conferência da próxima subida do app.
 */
async function checkReconcile(): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { agentService } = await import("../src/services/agent-service.js");
  const { runService } = await import("../src/services/run-service.js");
  const { ReconcileService } = await import("../src/services/reconcile-service.js");
  const { TriggerService } = await import("../src/services/trigger-service.js");
  const { executionService } = await import("../src/services/execution-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { Scheduler } = await import("../src/triggers/scheduler.js");
  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para reconciliar");
  const versao = await agentService.getLatestVersion(agent.id);
  if (versao === undefined) throw new Error(`agent ${agent.id} sem versao gravada`);

  const dono = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const repo = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const arquivo = "src/Auth/TokenValidator.cs";
  const problema = "`DateTime.Now` devolve hora local e o token expira tarde demais.";
  // Corpo do comentário humano inventado. Sai em variável porque o guarda de
  // i18n olha a propriedade `body`, e este texto é dado de teste, não produto.
  const comentario = "o mesmo ponto, visto por uma pessoa";

  const fechado = { runId: `smoke-run-${randomUUID()}`, eventId: `smoke-event-${randomUUID()}`, pull: 1 };
  const aberto = { runId: `smoke-run-${randomUUID()}`, eventId: `smoke-event-${randomUUID()}`, pull: 2 };

  for (const alvo of [fechado, aberto]) {
    await db.insert(schema.events).values({
      id: alvo.eventId,
      source: "github",
      externalId: `pr:${dono}/${repo}#${alvo.pull}:sha:abc123`,
      payload: { owner: dono, repoName: repo, pull: alvo.pull, headSha: "abc123" },
    });
    await db.insert(schema.runs).values({
      id: alvo.runId,
      agentVersionId: versao.id,
      eventId: alvo.eventId,
      triggerId: null,
      status: "done",
    });
    await db.insert(schema.steps).values({
      id: `${alvo.runId}-audit`,
      runId: alvo.runId,
      idx: 0,
      stepKey: "audit",
      name: "Auditoria",
      status: "done",
      output: {
        findings: [
          { file: arquivo, line: 41, severity: "critical", category: "correcao", problem: problema },
        ],
      },
    });
  }

  /** Quantas vezes cada pull request foi visitado, por número. */
  const visitas = new Map<number, number>();
  const olhar: AftermathFetcher = async (owner, nome, pull, sha) => {
    if (owner !== dono || nome !== repo) {
      throw new Error(`a conferencia visitou ${owner}/${nome}, que nao e o alvo plantado`);
    }
    visitas.set(pull, (visitas.get(pull) ?? 0) + 1);
    const encerrado = pull === fechado.pull;
    return {
      prKey: `${owner}/${nome}#${pull}`,
      state: encerrado ? "merged" : "open",
      headSha: sha,
      // O sinal cai na mesma linha do achado, que é o que faz o desfecho sair
      // como confirmado e não como ignorado.
      signals: encerrado
        ? [{ author: "revisora", kind: "comment" as const, file: arquivo, line: 41, body: comentario }]
        : [],
      changedAfter: new Map(),
    };
  };

  const conferencia = new ReconcileService(db, runService, olhar);
  const semGatilho = new (class extends TriggerService {
    async enabled() {
      return [];
    }
  })(db);
  const agendador = new Scheduler(db, semGatilho, executionService, mcpService, proibirVarredura, (o) =>
    conferencia.sweep(o),
  );

  try {
    // As contagens da batida sao pisos, e nao igualdades: o smoke roda no banco
    // de quem desenvolve, e uma execucao antiga de origem `github` entraria na
    // mesma fila. O que e exigido com numero exato e o que o contador de
    // visitas diz sobre as duas execucoes plantadas aqui.
    const primeira = await agendador.tick({ reason: "timer" });
    if (primeira.reconciled.settled < 1 || primeira.reconciled.stillOpen < 1) {
      throw new Error(
        `a primeira batida deu ${primeira.reconciled.settled} desfecho(s) e deixou ` +
          `${primeira.reconciled.stillOpen} aberto(s), e o esperado era ao menos um de cada`,
      );
    }
    if (visitas.get(fechado.pull) !== 1 || visitas.get(aberto.pull) !== 1) {
      throw new Error("a primeira batida nao visitou as duas execucoes plantadas uma vez cada");
    }

    const desfechos = await db
      .select({ state: schema.findingOutcomes.state })
      .from(schema.findingOutcomes)
      .innerJoin(schema.findings, eq(schema.findingOutcomes.findingId, schema.findings.id))
      .where(eq(schema.findings.runId, fechado.runId));
    if (desfechos.length !== 1 || desfechos[0]?.state !== "confirmed_by_human") {
      throw new Error(
        `a execucao fechada ganhou ${desfechos.length} desfecho(s): ` +
          `${desfechos.map((d) => d.state).join(", ")}`,
      );
    }
    const semDesfecho = await db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(eq(schema.findings.runId, aberto.runId));
    if (semDesfecho.length !== 0) {
      throw new Error("a execucao de PR aberto gravou achado antes de o pull request fechar");
    }

    const segunda = await agendador.tick({ reason: "timer" });
    if (segunda.reconciled.settled !== 0) {
      throw new Error(`a segunda batida gravou ${segunda.reconciled.settled} desfecho(s) de novo`);
    }
    if (visitas.get(fechado.pull) !== 1) {
      throw new Error(`o PR fechado foi visitado ${String(visitas.get(fechado.pull))} vez(es), e nao uma`);
    }
    if (visitas.get(aberto.pull) !== 2) {
      throw new Error(`o PR aberto foi visitado ${String(visitas.get(aberto.pull))} vez(es), e nao duas`);
    }

    return t("smoke.reconcile", { settled: primeira.reconciled.settled });
  } finally {
    const runIds = [fechado.runId, aberto.runId];
    const achados = await db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(inArray(schema.findings.runId, runIds));
    if (achados.length > 0) {
      await db.delete(schema.findingOutcomes).where(
        inArray(schema.findingOutcomes.findingId, achados.map((a) => a.id)),
      );
    }
    await db.delete(schema.findings).where(inArray(schema.findings.runId, runIds));
    await db.delete(schema.reviewSignals).where(eq(schema.reviewSignals.prKey, `${dono}/${repo}#${fechado.pull}`));
    await db.delete(schema.cursors).where(
      and(eq(schema.cursors.source, "reconcile"), inArray(schema.cursors.key, runIds)),
    );
    await db.delete(schema.steps).where(inArray(schema.steps.runId, runIds));
    await db.delete(schema.runs).where(inArray(schema.runs.id, runIds));
    await db.delete(schema.events).where(inArray(schema.events.id, [fechado.eventId, aberto.eventId]));
  }
}

/**
 * Prova que o interruptor desligado não custa uma requisição sequer.
 *
 * Ler o código e ver que ele decide não chamar não prova nada: a chamada que
 * importa é a que um temporizador faria três segundos depois, longe da linha
 * que alguém leu. Por isso aqui a saída de rede é contada de fora, e o critério
 * é a contagem, não a intenção.
 *
 * A segunda metade liga o interruptor e confere que ele é mesmo lido, pelo
 * `planUpdater`, que decide sem armar. Não é detalhe: num pacote com dmg o
 * `app-update.yml` existe, e chamar o `setupUpdater` ligado ali dentro faria o
 * smoke bater no servidor de releases. A preferência de quem desenvolve volta
 * ao que era no fim, porque o smoke roda no banco de verdade.
 */
async function checkUpdates(): Promise<string> {
  const { updateService } = await import("../src/services/update-service.js");
  const { planUpdater, setupUpdater, updaterArmed, espiarRede } = await import("./updater.js");

  const anterior = await updateService.getPreference();
  const espia = espiarRede();

  const semRede = (momento: string): void => {
    const vistas = espia.vistas();
    if (vistas.length === 0) return;
    const quais = vistas.map((v) => `${v.via} ${v.destino}`).join(", ");
    throw new Error(`atualização ${momento} saiu para a rede: ${quais}`);
  };

  try {
    await updateService.clearPreference();
    const desligado = await setupUpdater();
    if (desligado.enabled || desligado.armed || updaterArmed()) {
      throw new Error("o verificador de atualização armou com o interruptor desligado");
    }
    if (desligado.reason !== "disabled") {
      throw new Error(
        `sem preferência gravada o motivo deveria ser disabled, veio ${desligado.reason}`,
      );
    }
    semRede("desligada");

    await updateService.setEnabled(true);
    const ligado = await planUpdater();
    if (!ligado.enabled) throw new Error("o interruptor ligado não chegou ao verificador");
    if (ligado.armed || updaterArmed()) throw new Error("o plano do verificador armou sozinho");
    semRede("ligada");

    return t("smoke.updates", {
      requests: espia.vistas().length,
      feed: t(ligado.feed === null ? "smoke.feedAbsent" : "smoke.feedPresent"),
    });
  } finally {
    espia.parar();
    if (anterior === null) await updateService.clearPreference();
    else await updateService.setEnabled(anterior);
  }
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
  return t("smoke.secrets");
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

  return t("smoke.notifications");
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

  return t("smoke.deepLink", {
    scheme: t(protocolo.registered ? "smoke.schemeRegistered" : "smoke.schemeRefused"),
  });
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
    console.log(t("smoke.expectedRefusal"));
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

  return t("smoke.bridge", { channels: canais });
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
  const { ensureAgentHistory } = await import("../src/fixtures/agent-history.js");
  const { ensureFixtureServer } = await import("../src/fixtures/mcp-fixture.js");

  // Banco vazio faz a tela de execucoes passar sem provar nada: lista vazia e
  // detalhe inexistente batem com servico vazio por acidente. O fixture planta
  // uma execucao pronta, e nao roda o pipeline, que custaria minutos de
  // assinatura a cada verificacao do loop.
  const fixture = await ensureDemoRun();
  // A tela de agents compara duas versoes, e um banco novo so tem uma. O
  // fixture planta a que falta sem rodar nada, e deixa o spec canonico no topo.
  await ensureAgentHistory();
  // A tela de configuracao precisa de um servidor MCP para o botao de testar
  // ter alvo. O de brinquedo nao depende de rede nem de nada instalado, entao
  // conectar nele custa segundos e nao expoe o loop a servidor de terceiro.
  // O binario do Electron em modo Node, e nao o `node` do sistema: o pacote
  // nao pode supor Node instalado na maquina de quem abre o `.app`. O bundle
  // sai do asar porque quem o le e um processo filho, que nao tem o `fs`
  // remendado do Electron e nao enxerga caminho la dentro.
  await ensureFixtureServer({
    command: [process.execPath, foraDoAsar(join(__dirname, "mcp-fixture-server.mjs"))],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });

  setupBridge({ inboxTarget: pendingInboxTarget });

  const window = createWindow({ show: false });
  trustWindow(window);
  const erros: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") erros.push(event.message);
  });

  try {
    await window.loadFile(RENDERER);

    // A espera nao e frescura: a janela pergunta o idioma pela ponte antes de
    // desenhar, e conferir logo depois do `loadFile` pegaria a raiz ainda
    // vazia. Montar em ingles e corrigir depois faria a tela piscar em toda
    // subida de quem escolheu portugues, entao quem espera e o exame.
    const visto = await esperarProbe<{ raiz: number; marca: string; folha: string }>(
      window,
      "raiz",
      `(() => {
        const raiz = document.getElementById("root");
        if (raiz === null || raiz.childElementCount === 0) return null;
        const probe = document.querySelector("[data-locum-probe=tailwind]");
        return {
          raiz: raiz.childElementCount,
          marca: document.querySelector("[data-locum-probe=marca]")?.textContent ?? "",
          folha: probe === null ? "sem marcador" : getComputedStyle(probe).display,
        };
      })()`,
    );

    if (erros.length > 0) throw new Error(`o renderer registrou erro: ${erros.join(", ")}`);
    if (visto.marca !== "Locum") throw new Error(`a barra lateral montou com a marca ${visto.marca}`);
    if (visto.folha !== "none") {
      throw new Error(`o marcador do Tailwind ficou com display ${visto.folha} em vez de none`);
    }

    const rotas = await checkRoutes(window);
    const paleta = await checkPalette(window);
    // Antes das execucoes de proposito: o `checkRuns` deixa a janela no detalhe
    // de um run, que e onde a verificacao do destaque procura o bloco de codigo.
    const agents = await checkAgents(window);
    const configuracao = await checkConfig(window);

    const execucoes = await checkRuns(window, fixture);
    // O bloco de codigo mora no detalhe de uma execucao, que e quem vai usa-lo
    // de verdade: a saida de cada passo sai como JSON destacado. O `checkRuns`
    // deixa a janela nesse detalhe, entao o destaque e conferido de onde ele
    // aparece.
    const destacado = await esperarDestaque(window);
    const ponte = await esperarPonte(window);
    // Por ultimo de proposito: o exame recarrega a janela, e recarregar antes
    // jogaria fora o destino em que os outros exames deixaram a pagina.
    const idioma = await checkI18n(window);

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

    return t("smoke.renderer", {
      routes: rotas,
      palette: paleta,
      agents,
      config: configuracao,
      runs: execucoes,
      spans: destacado,
      windowRuns: ponte.runs,
      windowPending: ponte.pendencias,
      language: idioma,
    });
  } finally {
    // As capturas usam esta mesma janela, com a ponte ainda de pé: derrubar
    // antes deixaria a página sem quem responder e ela nem monta.
    if (capturas) await capturarTelas(window);
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

  // O cabeçalho que repetia o nome do destino saiu, porque a barra lateral já
  // marca onde a pessoa está. Quem responde qual destino está ativo passa a ser
  // a própria marcação da barra, que é o que alguém usando o aplicativo lê.
  for (const { id, titulo } of barra) {
    await irPara(window, id);

    const visto = (await window.webContents.executeJavaScript(
      `(() => {
        const ativo = document.querySelector("[data-locum-rota][aria-current=page]");
        return {
          marcado: ativo?.dataset.locumRota ?? null,
          titulo: ativo?.querySelector("span")?.textContent ?? "",
        };
      })()`,
    )) as { titulo: string; marcado: string | null };

    if (visto.marcado !== id) {
      throw new Error(`o destino ${id} esta ativo e a barra marca ${visto.marcado}`);
    }
    if (visto.titulo !== titulo) {
      throw new Error(`a barra marca ${id} com o nome ${visto.titulo} e nao ${titulo}`);
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

  return t("smoke.routes", { count: barra.length });
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

  return t("smoke.palette");
}

/**
 * Confere a tela de agents: a lista, o historico e a comparacao de versoes.
 *
 * Tudo que a janela mostra e conferido contra os mesmos servicos, e nao contra
 * numeros escritos aqui. O unico valor deste lado e a exigencia da story, que e
 * a diferenca de modo do passo de acao aparecer na comparacao: qual modo e de
 * cada versao sai do banco, porque o fixture pode mudar e o teste continua
 * valendo.
 *
 * O botao de contar tokens e conferido por existir, e nunca clicado. Clicar
 * subiria os servidores MCP citados pelo spec, e o loop roda sem ninguem
 * olhando: o que esta sendo provado aqui e a fiacao.
 */
async function checkAgents(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { machineId } = await import("../src/services/machine-service.js");
  const { providerService } = await import("../src/services/provider-service.js");

  await irPara(window, "agents");
  const lista = await esperarProbe<{ agents: string; total: number }>(
    window,
    "agents",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agents]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { agents: probe.dataset.agents, total: Number(probe.dataset.total) };
    })()`,
  );

  const doServico = await agentService.list();
  if (lista.agents !== doServico.map((a) => a.id).join(",")) {
    throw new Error(`a lista mostrou ${lista.agents} e o servico devolveu ${doServico.length} agent(s)`);
  }

  const desenhadas = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-agent]").length`,
  )) as number;
  if (desenhadas !== doServico.length) {
    throw new Error(`a lista desenhou ${desenhadas} linha(s) para ${doServico.length} agent(s)`);
  }

  // O alvo e quem tem historico: comparar versao exige duas, e um agent de uma
  // versao so provaria a tela de lista mais uma vez.
  let alvo: string | undefined;
  for (const agent of doServico) {
    if ((await agentService.listVersions(agent.id)).length >= 2) {
      alvo = agent.id;
      break;
    }
  }
  if (alvo === undefined) throw new Error("nenhum agent tem duas versoes para comparar");

  await irPara(window, "agents", alvo);
  const detalhe = await esperarProbe<{
    versoes: string;
    versao: number;
    comparando: string;
    diff: number;
    saiu: string;
    entrou: string;
  }>(
    window,
    "agent",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agent]");
      const diff = document.querySelector("[data-locum-probe=diff]");
      const passos = document.querySelector("[data-locum-passos]");
      // As previas de modelo sao uma terceira leitura, e ela so comeca depois
      // que o perfil da maquina chega: girar ate ela terminar e o que separa
      // conferir o que a maquina resolve de conferir o estado de carregando.
      if (probe === null || diff === null || passos === null) return null;
      if (probe.dataset.versoes === "") return null;
      if (passos.dataset.locumMaquina === "" || passos.dataset.locumPrevias !== "ready") return null;
      return {
        versoes: probe.dataset.versoes,
        versao: Number(probe.dataset.versao),
        comparando: probe.dataset.comparando,
        diff: Number(diff.dataset.locumDiff),
        saiu: diff.dataset.locumSaiu ?? "",
        entrou: diff.dataset.locumEntrou ?? "",
      };
    })()`,
  );

  const versoes = await agentService.listVersions(alvo);
  if (detalhe.versoes !== versoes.map((v) => v.version).join(",")) {
    throw new Error(`o historico mostrou ${detalhe.versoes} e o servico tem ${versoes.length} versao(oes)`);
  }
  if (detalhe.versao !== versoes[0]!.version) {
    throw new Error(`a tela abriu na v${detalhe.versao} e o topo do historico e a v${versoes[0]!.version}`);
  }

  const atual = versoes[0]!;
  const anterior = versoes[1]!;
  if (detalhe.comparando !== `${anterior.version}:${atual.version}`) {
    throw new Error(`a comparacao ficou em ${detalhe.comparando} e o par esperado e o topo com o anterior`);
  }

  const modo = (v: (typeof versoes)[number]): string | undefined =>
    v.spec.steps.find((p) => p.type === "action")?.mode;
  const de = modo(anterior);
  const para = modo(atual);
  if (de === undefined || para === undefined) {
    throw new Error(`a v${anterior.version} ou a v${atual.version} nao tem passo de acao`);
  }
  if (de === para) {
    throw new Error(`as duas versoes do topo tem o passo de acao em "${de}", nao ha diferenca de modo`);
  }
  if (detalhe.diff === 0) throw new Error("a comparacao nao apontou nenhuma linha diferente");
  if (!detalhe.saiu.includes(`"mode": "${de}"`)) {
    throw new Error(`a comparacao nao mostrou o modo "${de}" saindo da v${anterior.version}`);
  }
  if (!detalhe.entrou.includes(`"mode": "${para}"`)) {
    throw new Error(`a comparacao nao mostrou o modo "${para}" entrando na v${atual.version}`);
  }

  // O que a maquina resolve para cada passo de modelo, conferido contra o mesmo
  // servico: uma tabela repetida deste lado passaria a concordar consigo mesma.
  const naTela = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-modelo]")).map((e) => ({
      pedido: e.dataset.locumModelo,
      resolvido: e.dataset.locumResolvido ?? "",
    }))`,
  )) as { pedido: string; resolvido: string }[];

  const passosDeModelo = atual.spec.steps.filter((p) => p.type === "model");
  if (naTela.length !== passosDeModelo.length) {
    throw new Error(
      `a tela mostrou ${naTela.length} resolucao(oes) e a v${atual.version} tem ${passosDeModelo.length} passo(s) de modelo`,
    );
  }

  const previas = await providerService.resolvePreviews(
    passosDeModelo.map((p) => p.model),
    machineId,
  );
  for (const [i, passo] of passosDeModelo.entries()) {
    const previa = previas[i]!;
    const esperado = previa.ok ? previa.resolution.used : "";
    if (naTela[i]!.pedido !== passo.model) {
      throw new Error(`o passo ${passo.key} mostrou o modelo ${naTela[i]!.pedido} e o spec pede ${passo.model}`);
    }
    if (naTela[i]!.resolvido !== esperado) {
      throw new Error(
        `o passo ${passo.key} resolveu para "${naTela[i]!.resolvido}" na tela e "${esperado}" no servico`,
      );
    }
  }

  // Um spec sem ferramenta nao tem botao, e isso nao e falha: o agent semente
  // herda a lista vazia. O que nao pode e existir ferramenta sem como contar.
  const comFerramenta = passosDeModelo.filter(
    (p) => (p.tools ?? atual.spec.defaultTools).length > 0,
  ).length;
  const botoes = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-contar]").length`,
  )) as number;
  if (botoes !== comFerramenta) {
    throw new Error(`${botoes} botao(oes) de contar token para ${comFerramenta} passo(s) com ferramenta`);
  }

  return t("smoke.agents", {
    agents: lista.total,
    versions: versoes.length,
    agent: alvo,
    from: de,
    to: para,
  });
}

/**
 * Confere a tela de configuracao.
 *
 * As quatro secoes sao comparadas contra os mesmos servicos que a janela leu
 * pela ponte, e nao contra numeros escritos deste lado: uma tabela repetida
 * aqui passaria a concordar consigo mesma no dia em que a tela mudasse.
 *
 * O botao de testar conexao e clicado, ao contrario do de reexecutar passo.
 * A diferenca nao e de gosto: reexecutar solta o executor de verdade e gasta
 * assinatura, enquanto testar sobe o servidor de brinquedo, que e local e nao
 * fala com ninguem. E e o unico jeito de provar o que a story pede, que e o
 * teste respondendo na interface e nao so o canal existindo.
 *
 * O que nao aparece em lugar nenhum e valor de segredo, e a verificacao cobra
 * isso: o marcador de credencial carrega a referencia e se ha algo guardado,
 * e mais nada.
 */
async function checkConfig(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { machineId } = await import("../src/services/machine-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { providerService } = await import("../src/services/provider-service.js");
  const { FIXTURE_SERVER } = await import("../src/fixtures/mcp-fixture.js");

  await irPara(window, "configuracao");
  const tela = await esperarProbe<{
    maquina: string;
    provedores: string;
    fallbacks: number;
    servidores: string;
    orcamentos: string;
  }>(
    window,
    "configuracao",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=configuracao]");
      if (probe === null || probe.dataset.estado !== "pronto") return null;
      return {
        maquina: probe.dataset.locumMaquina,
        provedores: probe.dataset.locumProvedores,
        fallbacks: Number(probe.dataset.locumFallbacks),
        servidores: probe.dataset.locumServidores,
        orcamentos: probe.dataset.locumOrcamentos,
      };
    })()`,
  );

  if (tela.maquina !== machineId) {
    throw new Error(`a tela diz estar em "${tela.maquina}" e a maquina e "${machineId}"`);
  }

  const provedores = providerService.listProviders();
  if (tela.provedores !== provedores.map((p) => p.name).join(",")) {
    throw new Error(
      `a tela listou os provedores ${tela.provedores} e o servico tem ${provedores.length}`,
    );
  }

  // Disponibilidade por provider, e nao so a contagem: uma tela que mostrasse
  // todo mundo como indisponivel teria a mesma lista e diria outra coisa.
  const disponiveis = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-provider]")).map((e) => ({
      nome: e.dataset.locumProvider,
      disponivel: e.dataset.locumDisponivel,
    }))`,
  )) as { nome: string; disponivel: string }[];
  for (const [i, provedor] of provedores.entries()) {
    const naTela = disponiveis[i];
    const esperado = provedor.available ? "sim" : "nao";
    if (naTela === undefined || naTela.disponivel !== esperado) {
      throw new Error(
        `o provider ${provedor.name} aparece como "${naTela?.disponivel ?? "ausente"}" e o servico diz "${esperado}"`,
      );
    }
  }

  const fallbacks = await providerService.getFallbacks(machineId);
  const linhasDeFallback = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-fallback]")).map((e) => e.dataset.locumFallback)`,
  )) as string[];
  const esperadas = fallbacks.map((f) => `${f.fromModel}>${f.toModel}`);
  if (tela.fallbacks !== fallbacks.length || linhasDeFallback.join("|") !== esperadas.join("|")) {
    throw new Error(
      `a tabela de substituicao desenhou ${linhasDeFallback.join("|")} e o servico tem ${esperadas.join("|")}`,
    );
  }

  const servidores = await mcpService.list();
  if (tela.servidores !== servidores.map((s) => s.config.name).join(",")) {
    throw new Error(
      `a tela listou os servidores ${tela.servidores} e o servico tem ${servidores.length}`,
    );
  }
  if (!tela.servidores.split(",").includes(FIXTURE_SERVER)) {
    throw new Error(`o servidor de brinquedo ${FIXTURE_SERVER} nao apareceu na tela`);
  }

  const orcamentos = await agentService.budgets();
  if (tela.orcamentos !== orcamentos.map((o) => o.agentId).join(",")) {
    throw new Error(
      `a tela listou os orcamentos de ${tela.orcamentos} e o servico tem ${orcamentos.length}`,
    );
  }

  // Segredo nao tem como chegar na tela, porque nao ha canal que o devolva. O
  // que da para conferir daqui e que o marcador nao guarda nada alem do
  // endereco e do sim ou nao, e e isso que esta sendo olhado.
  const credenciais = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-credencial]")).map((e) => ({
      ref: e.dataset.locumCredencial,
      guardado: e.dataset.locumGuardado,
    }))`,
  )) as { ref: string; guardado: string }[];
  for (const credencial of credenciais) {
    if (credencial.guardado !== "sim" && credencial.guardado !== "nao") {
      throw new Error(`a credencial ${credencial.ref} mostrou "${credencial.guardado}"`);
    }
  }

  // O clique, que e o ponto da story. Ele sobe o servidor de brinquedo, que e
  // local: nao ha rede, nao ha assinatura e nao ha nada publicado.
  const clicou = (await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector('[data-locum-testar="${FIXTURE_SERVER}"]');
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  )) as boolean;
  if (!clicou) throw new Error(`a tela nao ofereceu botao de testar ${FIXTURE_SERVER}`);

  // Subir o processo e esperar a primeira resposta leva mais que uma leitura
  // de banco, e o tsx ainda compila o fixture antes de responder.
  const resultado = await esperarProbe<{ ok: string; ferramentas: number }>(
    window,
    `teste de ${FIXTURE_SERVER}`,
    `(() => {
      const probe = document.querySelector('[data-locum-teste="${FIXTURE_SERVER}"]');
      if (probe === null) return null;
      return { ok: probe.dataset.locumOk, ferramentas: Number(probe.dataset.locumFerramentas) };
    })()`,
    60_000,
  );

  const doServico = await mcpService.testConnection(FIXTURE_SERVER);
  if (resultado.ok !== (doServico.ok ? "sim" : "nao")) {
    throw new Error(
      `a tela disse "${resultado.ok}" para a conexao e o servico disse "${doServico.ok ? "sim" : "nao"}"` +
        (doServico.error === undefined ? "" : `: ${doServico.error}`),
    );
  }
  if (!doServico.ok) throw new Error(`o servidor de brinquedo nao conectou: ${doServico.error}`);
  if (resultado.ferramentas !== doServico.toolCount) {
    throw new Error(
      `a tela contou ${resultado.ferramentas} ferramenta(s) e o servico contou ${doServico.toolCount}`,
    );
  }

  const github = await checkGithub(window);
  const watched = await checkWatched(window);

  return t("smoke.config", {
    providers: provedores.length,
    fallbacks: fallbacks.length,
    servers: servidores.length,
    fixture: FIXTURE_SERVER,
    tools: resultado.ferramentas,
    budgets: orcamentos.length,
    github,
    watched,
  });
}

/**
 * Confere a secao dos repositorios observados, sem varrer nada.
 *
 * O caminho inteiro da story cabe dentro da maquina: cadastrar pela tela,
 * conferir que o gatilho nasceu parado, liga-lo e ver o agendador calcular a
 * proxima batida, e remover. Nenhum desses passos fala com o GitHub, porque
 * quem falaria e a batida, e batida nenhuma acontece aqui: o `tick` nao e
 * chamado, e o gatilho e removido antes de o smoke sair.
 *
 * O dono e o padrao de repositorio sao sorteados de proposito. O smoke roda no
 * banco de quem desenvolve, e um padrao que casasse com repositorio de verdade
 * deixaria para tras um gatilho apontado para trabalho real caso a limpeza
 * falhasse.
 */
async function checkWatched(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { triggerService } = await import("../src/services/trigger-service.js");
  const { scheduler } = await import("../src/triggers/scheduler.js");

  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para observar repositorio");

  const dono = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const repo = `^locum-smoke-${randomUUID().slice(0, 8)}$`;
  const cadencia = 7;
  const antes = (await triggerService.list()).map((gatilho) => gatilho.id);

  const preencheu = await window.webContents.executeJavaScript(
    `(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      const digitar = (seletor, valor) => {
        const campo = document.querySelector(seletor);
        if (campo === null) return false;
        setter.call(campo, valor);
        campo.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const escolher = () => {
        const campo = document.querySelector("[data-locum-observar-agent]");
        if (campo === null) return false;
        campo.value = ${JSON.stringify(agent.id)};
        campo.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      if (!escolher()) return false;
      if (!digitar("[data-locum-observar-dono]", ${JSON.stringify(dono)})) return false;
      if (!digitar("[data-locum-observar-repo]", ${JSON.stringify(repo)})) return false;
      if (!digitar("[data-locum-observar-cadencia]", ${JSON.stringify(String(cadencia))})) {
        return false;
      }
      const botao = document.querySelector("[data-locum-observar-salvar]");
      if (botao === null || botao.disabled) return false;
      botao.click();
      return true;
    })()`,
  );
  if (preencheu !== true) throw new Error("a tela nao ofereceu o formulario de observar");

  // O identificador so existe depois de o servico gravar, entao ele e
  // descoberto por diferenca em vez de vir da tela: assim o exame nao depende
  // de o marcador estar certo para achar o que tem que limpar depois.
  const criado = await esperarDoServico(
    "gatilho cadastrado pela tela",
    async () => (await triggerService.list()).find((gatilho) => !antes.includes(gatilho.id)),
  );

  try {
    // A recusa da ponte vira mensagem daqui antes de virar espera estourada:
    // "o marcador nao ficou pronto" nao diz por que a linha nao apareceu.
    const recusa = (await window.webContents.executeJavaScript(
      `document.querySelector("[data-locum-observados-erro]")
        ?.dataset.locumObservadosErro ?? null`,
    )) as string | null;
    if (recusa !== null) throw new Error(`a secao de observados recusou: ${recusa}`);

    if (criado.enabled) throw new Error("o gatilho cadastrado pela tela nasceu habilitado");
    if (criado.config.kind !== "poll") {
      throw new Error(`a tela cadastrou um gatilho do tipo ${criado.config.kind}`);
    }
    if (criado.config.owner !== dono || criado.config.repoMatch !== repo) {
      throw new Error(
        `a tela gravou ${criado.config.owner}/${criado.config.repoMatch} e nao ${dono}/${repo}`,
      );
    }
    if (criado.config.everyMinutes !== cadencia) {
      throw new Error(`a cadencia gravada foi ${criado.config.everyMinutes} e nao ${cadencia}`);
    }

    const parado = (await scheduler.schedule()).find((s) => s.triggerId === criado.id);
    if (parado === undefined) throw new Error("o gatilho novo nao apareceu no agendador");
    // Parado nao tem proxima batida, e dizer uma data aqui seria prometer na
    // tela uma varredura que o agendador nao vai fazer.
    if (parado.nextDueAt !== null) {
      throw new Error(`o gatilho parado disse que bate em ${parado.nextDueAt}`);
    }

    const naTela = await esperarProbe<{ habilitado: string; alvo: string; proxima: string }>(
      window,
      "gatilho na tela",
      `(() => {
        const linha = document.querySelector('[data-locum-gatilho="${criado.id}"]');
        if (linha === null) return null;
        return {
          habilitado: linha.dataset.locumGatilhoHabilitado,
          alvo: linha.dataset.locumGatilhoAlvo,
          proxima: linha.dataset.locumGatilhoProxima,
        };
      })()`,
    );
    if (naTela.habilitado !== "nao") throw new Error("a tela mostrou o gatilho novo como ligado");
    if (naTela.alvo !== `${dono}/${repo}`) {
      throw new Error(`a tela mostrou o alvo ${naTela.alvo} e o cadastro diz ${dono}/${repo}`);
    }
    if (naTela.proxima !== "") {
      throw new Error(`a tela anunciou a batida ${naTela.proxima} de um gatilho parado`);
    }

    // O clique que a story cobra: ligado, ele aparece no agendador com a
    // proxima batida calculada. Ligar nao varre; quem varreria e o `tick`, que
    // este exame nao chama.
    const cliquei = Date.now();
    const ligou = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-gatilho-ligar="${criado.id}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (ligou !== true) throw new Error("a tela nao ofereceu botao de ligar o gatilho");

    await esperarProbe<true>(
      window,
      "gatilho ligado pela tela",
      `document.querySelector('[data-locum-gatilho="${criado.id}"]')
        ?.dataset.locumGatilhoHabilitado === "sim" ? true : null`,
    );

    // O relogio e passado de fora para que as duas perguntas abaixo respondam
    // sobre o mesmo instante: gatilho que nunca disparou esta vencido agora, e
    // com dois `Date.now()` a comparacao viraria uma corrida de milissegundos.
    const agora = Date.now();
    const ligado = (await scheduler.schedule(agora)).find((s) => s.triggerId === criado.id);
    if (ligado?.enabled !== true) throw new Error("o gatilho ligado na tela continuou parado");
    if (ligado.nextDueAt === null) {
      throw new Error("o agendador nao calculou a proxima batida do gatilho ligado");
    }
    if (ligado.everyMinutes !== cadencia) {
      throw new Error(`o agendador leu a cadencia ${ligado.everyMinutes} e nao ${cadencia}`);
    }
    // Vencido, e nao daqui a uma cadencia: esperar sete minutos para a primeira
    // varredura de um gatilho que alguem acabou de ligar seria demora que
    // ninguem pediu.
    if (ligado.nextDueAt !== agora) {
      throw new Error(`o gatilho ligado agora quer bater em ${ligado.nextDueAt}`);
    }
    if ((await scheduler.nextDueAt(agora)) !== agora) {
      throw new Error("a batida do gatilho novo ficou de fora da proxima batida do agendador");
    }

    const naTelaLigado = await esperarProbe<string>(
      window,
      "batida do gatilho na tela",
      `(() => {
        const linha = document.querySelector('[data-locum-gatilho="${criado.id}"]');
        const proxima = linha?.dataset.locumGatilhoProxima;
        return proxima === undefined || proxima === "" ? null : proxima;
      })()`,
    );
    // A tela leu com o relogio dela, entao o que da para exigir e a janela: a
    // batida anunciada caiu entre o clique de ligar e agora, que e o que
    // "vencido" quer dizer. Igualdade exata aqui seria exigir que os dois lados
    // tivessem lido o relogio no mesmo milissegundo.
    const anunciada = Number(naTelaLigado);
    if (!Number.isFinite(anunciada) || anunciada < cliquei || anunciada > Date.now()) {
      throw new Error(`a tela anunciou a batida ${naTelaLigado}, fora da janela do clique`);
    }

    const removeu = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-gatilho-remover="${criado.id}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (removeu !== true) throw new Error("a tela nao ofereceu botao de remover o gatilho");

    await esperarProbe<true>(
      window,
      "gatilho removido pela tela",
      `document.querySelector('[data-locum-gatilho="${criado.id}"]') === null ? true : null`,
    );
    if ((await triggerService.list()).some((gatilho) => gatilho.id === criado.id)) {
      throw new Error("o gatilho sobreviveu ao remover da tela");
    }

    return t("smoke.watched", {
      target: `${dono}/${repo}`,
      next: new Date(ligado.nextDueAt).toISOString(),
    });
  } finally {
    // O clique de remover pode nao ter chegado, e um gatilho de varredura
    // habilitado sobrevivendo ao smoke faria a proxima subida do app sair
    // varrendo uma organizacao que nao existe.
    await triggerService.remove(criado.id);
  }
}

/**
 * Espera o servico responder alguma coisa, com a mesma cadencia do `esperarProbe`.
 *
 * Existe porque o clique na tela e assincrono dos dois lados: o `call` volta
 * pela ponte e so depois o servico grava. Perguntar uma vez so ao banco daria
 * falso negativo por milissegundos.
 */
async function esperarDoServico<T>(
  nome: string,
  ler: () => Promise<T | undefined>,
  limiteMs = 20_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;

  while (Date.now() < limite) {
    const visto = await ler();
    if (visto !== undefined) return visto;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${nome} nao apareceu dentro de ${limiteMs / 1000}s`);
}

/**
 * Confere a secao da credencial do GitHub, sem nunca falar com o GitHub.
 *
 * O marco proibe credencial de verdade, e essa proibicao nao tira nada do que
 * a story pede: guardar, ler do cofre, conferir e esquecer sao quatro caminhos
 * que terminam dentro da maquina. O unico pedaco que sairia daqui e a resposta
 * do GitHub a um token, e ela e exercitada pelo servico com uma sonda trocada,
 * que e o que existe para isso no construtor.
 *
 * O exame roda contra uma referencia sorteada, e nao contra `source/github`. O
 * smoke roda no banco e no cofre de quem desenvolve, e escrever na referencia
 * de verdade apagaria um token que pode estar em uso.
 *
 * Na interface, o clique de conferir so acontece com o cofre vazio, quando a
 * resposta e "nao ha token" e nao sai da maquina. Com token guardado o exame
 * pula o clique de proposito: ele viraria uma chamada autenticada a API do
 * GitHub com a credencial de alguem, feita por um loop que roda sem ninguem
 * olhando.
 */
async function checkGithub(window: BrowserWindow): Promise<string> {
  const { secretService } = await import("../src/services/secret-service.js");
  const { settingsService } = await import("../src/services/settings-service.js");
  const {
    GITHUB_CREDENTIAL_REF,
    GITHUB_TOKEN_ENV,
    GithubService,
    githubToken,
  } = await import("../src/services/github-service.js");

  if (!secretService.available) throw new Error("keychain indisponivel para o cofre do GitHub");

  const ref = `source/locum-smoke-${randomUUID().slice(0, 8)}`;
  const token = `token-de-mentira-${randomUUID()}`;
  let recebido: string | null = null;

  const servico = new GithubService(
    secretService,
    settingsService,
    async (visto) => {
      recebido = visto;
      return { login: "locum-smoke", scopes: ["repo", "read:org"] };
    },
    ref,
  );

  try {
    const vazio = await servico.status();
    if (vazio.stored) throw new Error(`a referencia sorteada ${ref} ja tinha valor`);
    if (vazio.identity !== null) throw new Error("uma referencia nova nasceu com identidade");

    // Sem token, a conferencia responde de dentro da maquina: a sonda nao e
    // chamada, e e por isso que `recebido` continua nulo logo abaixo.
    const semToken = await servico.check();
    if (semToken.ok || semToken.reason !== "missing") {
      throw new Error(`sem token a conferencia respondeu ${JSON.stringify(semToken)}`);
    }
    if (recebido !== null) throw new Error("a conferencia saiu perguntando sem ter token");

    await servico.setToken(token);
    if (readFileSync(secretService.pathFor(ref)).includes(token)) {
      throw new Error("o token do GitHub foi para o disco em claro");
    }

    const conferida = await servico.check();
    if (!conferida.ok) throw new Error(`a conferencia recusou: ${JSON.stringify(conferida)}`);
    if (recebido !== token) throw new Error("a sonda recebeu um token diferente do guardado");
    if (conferida.login !== "locum-smoke") {
      throw new Error(`a conferencia devolveu a conta ${conferida.login}`);
    }

    const depois = await servico.status();
    if (!depois.stored) throw new Error("o token nao ficou guardado");
    if (depois.identity?.login !== "locum-smoke" || depois.checkedAt === null) {
      throw new Error("a identidade conferida nao sobreviveu ao status");
    }

    // Trocar o token joga fora a conta que era dele. Sem isso a tela mostraria
    // o login antigo ao lado de um token novo, com cara de dado conferido.
    await servico.setToken(`${token}-outro`);
    const trocado = await servico.status();
    if (trocado.identity !== null || trocado.checkedAt !== null) {
      throw new Error("a identidade do token anterior sobreviveu a troca");
    }

    if (!(await servico.clearToken())) throw new Error("esquecer nao achou o que apagar");
    if ((await servico.status()).stored) throw new Error("o token sobreviveu ao esquecer");
  } finally {
    secretService.remove(ref);
    await new GithubService(secretService, settingsService, undefined, ref).clearToken();
  }

  // O caminho que o source usa, com a variavel de ambiente fora do ar: e esse
  // "sem variavel de ambiente" que a story cobra.
  const doAmbiente = process.env[GITHUB_TOKEN_ENV];
  delete process.env[GITHUB_TOKEN_ENV];
  const jaGuardado = secretService.has(GITHUB_CREDENTIAL_REF);
  try {
    if (jaGuardado) {
      // Quem desenvolve ja guardou o token dele. Sobrescrever para provar o
      // caminho seria destruir o que esta em uso, entao o que se confere e que
      // o cofre responde sem o ambiente, que e a mesma afirmacao.
      const lido = githubToken();
      if (lido === undefined) throw new Error("o cofre tinha token e o source nao o enxergou");
    } else {
      secretService.set(GITHUB_CREDENTIAL_REF, token);
      try {
        if (githubToken() !== token) {
          throw new Error("o source nao leu do cofre o token que a interface guardaria");
        }
      } finally {
        secretService.remove(GITHUB_CREDENTIAL_REF);
      }
      if (githubToken() !== undefined) throw new Error("o token sobreviveu ao remove");
    }
  } finally {
    if (doAmbiente !== undefined) process.env[GITHUB_TOKEN_ENV] = doAmbiente;
  }

  // Agora a interface, que e o que a story entrega. A tela ja esta montada; o
  // marcador espera a leitura de `github.status` responder.
  const naTela = await esperarProbe<{ guardado: string; cofre: string; ambiente: string }>(
    window,
    "github",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=github]");
      if (probe === null || probe.dataset.locumGithubGuardado === "") return null;
      return {
        guardado: probe.dataset.locumGithubGuardado,
        cofre: probe.dataset.locumGithubCofre,
        ambiente: probe.dataset.locumGithubAmbiente,
      };
    })()`,
  );

  if (naTela.cofre !== "aberto") throw new Error("a tela diz que o cofre esta fechado");
  const esperado = secretService.has(GITHUB_CREDENTIAL_REF) ? "sim" : "nao";
  if (naTela.guardado !== esperado) {
    throw new Error(`a tela diz "${naTela.guardado}" e o cofre diz "${esperado}"`);
  }

  if (esperado === "sim") {
    // Com token guardado nao ha o que exercitar sem sair da maquina, e o que a
    // linha final do smoke diz e exatamente isso, sem fingir que conferiu.
    return t("smoke.github", { path: t("smoke.githubStored") });
  }

  const clicouConferir = await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector("[data-locum-github-conferir]");
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  );
  if (clicouConferir !== true) throw new Error("a tela nao ofereceu botao de conferir");

  const semTokenNaTela = await esperarProbe<string>(
    window,
    "conferencia do github",
    `document.querySelector("[data-locum-github-resultado]")?.dataset.locumGithubResultado ?? null`,
  );
  if (semTokenNaTela !== "missing") {
    throw new Error(`a tela respondeu "${semTokenNaTela}" para conferir sem token`);
  }

  // Digitar e guardar, que e o caminho que a story pede. O valor e de mentira e
  // sai logo abaixo; o que esta sendo provado e que ele chega ao cofre e que a
  // tela nao o mostra de volta.
  const guardou = await window.webContents.executeJavaScript(
    `(() => {
      const campo = document.querySelector("[data-locum-github-token]");
      const botao = document.querySelector("[data-locum-github-salvar]");
      if (campo === null || botao === null) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(campo, ${JSON.stringify(token)});
      campo.dispatchEvent(new Event("input", { bubbles: true }));
      botao.click();
      return true;
    })()`,
  );
  if (guardou !== true) throw new Error("a tela nao ofereceu campo e botao de guardar");

  try {
    await esperarProbe<true>(
      window,
      "token guardado pela tela",
      `document.querySelector("[data-locum-probe=github]")?.dataset.locumGithubGuardado === "sim"
        ? true
        : null`,
    );

    if (githubToken() !== token) {
      throw new Error("o que a tela guardou nao foi o que o source leu do cofre");
    }

    // O campo volta vazio e o valor nao aparece em lugar nenhum da pagina. E o
    // ponto da story: a tela grava segredo e nao o mostra, nem por acidente.
    const naPagina = await window.webContents.executeJavaScript(
      `(() => ({
        campo: document.querySelector("[data-locum-github-token]").value,
        html: document.documentElement.outerHTML.includes(${JSON.stringify(token)}),
      }))()`,
    );
    const visto = naPagina as { campo: string; html: boolean };
    if (visto.campo !== "") throw new Error("o campo ficou com o token depois de guardar");
    if (visto.html) throw new Error("o token apareceu no HTML da pagina");
  } finally {
    secretService.remove(GITHUB_CREDENTIAL_REF);
  }

  const esqueceu = await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector("[data-locum-github-esquecer]");
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  );
  if (esqueceu !== true) throw new Error("a tela nao ofereceu botao de esquecer");

  await esperarProbe<true>(
    window,
    "token esquecido pela tela",
    `document.querySelector("[data-locum-probe=github]")?.dataset.locumGithubGuardado === "nao"
      ? true
      : null`,
  );

  return t("smoke.github", { path: t("smoke.githubRoundTrip") });
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

  const grafo = await checkGrafo(window, doBanco);

  return t("smoke.runs", {
    runs: lista.total,
    rows: desenhadas,
    steps: detalhe.passos,
    findings: detalhe.achados,
    graph: grafo,
  });
}

/**
 * Confere o grafo do run que esta aberto na janela.
 *
 * O esperado sai do `needs` do spec, e nao de uma lista escrita aqui: o que
 * precisa ser provado e que o desenho segue a dependencia declarada, e nao que
 * alguem lembrou de atualizar dois lugares ao mesmo tempo.
 *
 * O no e a aresta sao contados no DOM alem de conferidos no marcador, pelo
 * mesmo motivo da lista virtualizada: um grafo que montasse a conta certa e
 * desenhasse nada passaria pela primeira conferencia inteira.
 */
async function checkGrafo(
  window: BrowserWindow,
  run: Awaited<ReturnType<RunService["get"]>>,
): Promise<string> {
  if (run === undefined) throw new Error("o grafo foi conferido sem run");

  const chaves = run.spec.steps.map((p) => p.key);
  const esperadas = run.spec.steps.flatMap((passo) =>
    passo.needs.filter((n) => chaves.includes(n)).map((n) => `${n}->${passo.key}`),
  );
  if (esperadas.length !== 3) {
    throw new Error(`o agent semente passou a ter ${esperadas.length} arestas e o smoke espera tres`);
  }

  const visto = await esperarProbe<{
    arestas: string;
    desenhadas: number;
    estados: string;
    nos: string;
  }>(
    window,
    "grafo",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=grafo]");
      if (probe === null) return null;
      const caixas = Array.from(document.querySelectorAll("[data-locum-no]"));
      // A aresta so entra no DOM depois que o React Flow mede as caixas, que e
      // um quadro depois do no aparecer: sem esta espera a contagem sairia
      // zero com o grafo certo na tela.
      const linhas = document.querySelectorAll(".react-flow__edge").length;
      if (caixas.length === 0 || linhas === 0) return null;
      return {
        arestas: probe.dataset.arestas,
        desenhadas: linhas,
        estados: caixas.map((c) => c.dataset.locumNo + ":" + c.dataset.locumEstado).join(","),
        nos: probe.dataset.nos,
      };
    })()`,
  );

  if (visto.nos !== chaves.join(",")) {
    throw new Error(`o grafo listou os nos ${visto.nos} e o spec tem ${chaves.join(",")}`);
  }
  if (visto.arestas !== esperadas.join(",")) {
    throw new Error(`o grafo listou as arestas ${visto.arestas} e o spec pede ${esperadas.join(",")}`);
  }
  if (visto.desenhadas !== esperadas.length) {
    throw new Error(`o grafo desenhou ${visto.desenhadas} aresta(s) e o spec pede ${esperadas.length}`);
  }

  // O estado por no e o que separa "desenhou caixa" de "desenhou o run": o
  // passo pulado e o que espera aprovacao so aparecem se vierem do banco.
  const doBanco = run.steps.map((p) => `${p.stepKey}:${p.status}`).join(",");
  if (visto.estados !== doBanco) {
    throw new Error(`o grafo mostrou ${visto.estados} e o run esta em ${doBanco}`);
  }
  for (const exigido of ["skipped", "awaiting_approval"]) {
    if (!visto.estados.includes(`:${exigido}`)) {
      throw new Error(`o grafo do fixture nao mostrou nenhum passo ${exigido}`);
    }
  }

  return t("smoke.graph", {
    nodes: chaves.length,
    edges: visto.desenhadas,
    states: visto.estados,
  });
}

/**
 * Gira ate o marcador responder com algo que nao seja nulo.
 *
 * O limite entra por parametro porque nem toda espera e da mesma natureza:
 * uma leitura de banco responde em milissegundos, e um teste de conexao MCP
 * sobe um processo antes de responder.
 */
async function esperarProbe<T>(
  window: BrowserWindow,
  nome: string,
  script: string,
  limiteMs = 20_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;

  while (Date.now() < limite) {
    const visto = (await window.webContents.executeJavaScript(script)) as T | null;
    if (visto !== null) return visto;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`o marcador ${nome} nao ficou pronto dentro de ${limiteMs / 1000}s`);
}

type Dicionario = typeof en;

/**
 * O texto que o dicionário tem para uma chave, lido do arquivo.
 *
 * O exame não pergunta pelo mesmo `t` que monta a bandeja e a notificação: duas
 * chamadas à mesma porta concordariam entre si até com o dicionário vazio. Aqui
 * o JSON é lido direto, e o que está sendo comparado é o texto que o tradutor
 * escreveu com o que apareceu no menu.
 *
 * A forma de plural sai do `Intl.PluralRules`, que é o que o i18next usa do
 * outro lado. Reimplementar a regra, ainda que com um `if`, faria o exame
 * concordar consigo mesmo: em português a forma "one" cobre o zero, e um exame
 * que não soubesse disso passaria a exigir o texto errado. O `_zero` é a
 * exceção que o próprio i18next abre para contagem zero, e vem antes das formas.
 */
type Vars = Record<string, string | number>;

function doDicionario(
  dicionario: Dicionario,
  idioma: string,
  caminho: string,
  vars: Vars = {},
): string {
  const partes = caminho.split(".");
  const folha = partes.pop() ?? "";
  let no: unknown = dicionario;
  for (const parte of partes) no = (no as Record<string, unknown>)[parte];
  const formas = no as Record<string, string | undefined>;

  const count = vars["count"];
  const chaves =
    typeof count === "number"
      ? [
          ...(count === 0 ? [`${folha}_zero`] : []),
          `${folha}_${new Intl.PluralRules(idioma).select(count)}`,
          `${folha}_other`,
        ]
      : [folha];

  const modelo = chaves.map((chave) => formas[chave]).find((texto) => texto !== undefined);
  if (modelo === undefined) throw new Error(`o dicionario ${idioma} nao tem ${caminho}`);

  return Object.entries(vars).reduce(
    (texto, [nome, valor]) => texto.replaceAll(`{{${nome}}}`, String(valor)),
    modelo,
  );
}

interface IdiomaVisto {
  idioma: string;
  documento: string;
  preferencia: string;
  estrito: string;
  rodape: string;
  runs: number;
}

/** O texto que cada tela desenhou, com o que ela contou. */
interface TelasVistas {
  inbox: string;
  pendencias: number;
  execucoes: string;
  total: number;
  agents: string;
  quantosAgents: number;
  orcamento: string;
  execucoesDeHoje: number;
  gastoDeHoje: string;
}

/**
 * O que a janela aplicou de idioma, junto do rodapé que ela desenhou.
 *
 * O rodapé entra porque atributo de marcador prova que o estado chegou, e não
 * que o texto mudou: uma tradução esquecida deixaria o marcador em `pt-BR` com
 * a tela inteira em inglês. O exame espera as leituras terminarem antes de
 * olhar, senão pegaria o texto de "carregando" em vez do plural.
 */
async function lerIdioma(window: BrowserWindow): Promise<IdiomaVisto> {
  return esperarProbe<IdiomaVisto>(
    window,
    "idioma",
    `(() => {
      const idioma = document.querySelector("[data-locum-probe=idioma]");
      const ponte = document.querySelector("[data-locum-probe=ponte]");
      if (idioma === null || ponte === null) return null;
      if (ponte.dataset.estado !== "pronto") return null;
      return {
        idioma: idioma.dataset.idioma,
        documento: document.documentElement.lang,
        preferencia: idioma.dataset.preferencia,
        estrito: idioma.dataset.estrito,
        rodape: (ponte.textContent ?? "").trim(),
        runs: Number(ponte.dataset.runs),
      };
    })()`,
  );
}

/**
 * O que as quatro telas escreveram, no idioma corrente.
 *
 * Todas elas contam coisas, e contagem e onde tradução quebra primeiro: o
 * plural do português troca a palavra, e um texto montado com "(oes)" no fim
 * passaria por qualquer conferência de marcador. Por isso o exame compara a
 * frase inteira com o dicionário, e não só o número ao lado dela.
 *
 * De configuração vem a linha de gasto do dia, e não um título de seção: o
 * título sairia igual traduzido ou não numa tela onde o resto ficou em
 * inglês, e a frase com plural não sai.
 */
async function lerTelas(window: BrowserWindow): Promise<TelasVistas> {
  await irPara(window, "inbox");
  const inbox = await esperarProbe<{ texto: string; pendencias: number }>(
    window,
    "inbox",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=inbox]");
      if (probe === null) return null;
      return { texto: (probe.textContent ?? "").trim(), pendencias: Number(probe.dataset.pendencias) };
    })()`,
  );

  await irPara(window, "execucoes");
  const execucoes = await esperarProbe<{ texto: string; total: number }>(
    window,
    "execucoes",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=execucoes]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { texto: (probe.textContent ?? "").trim(), total: Number(probe.dataset.total) };
    })()`,
  );

  await irPara(window, "agents");
  const agents = await esperarProbe<{ texto: string; total: number }>(
    window,
    "agents",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agents]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { texto: (probe.textContent ?? "").trim(), total: Number(probe.dataset.total) };
    })()`,
  );

  await irPara(window, "configuracao");
  const orcamento = await esperarProbe<{ texto: string; runs: number; gasto: string }>(
    window,
    "orcamento",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=configuracao]");
      if (probe === null || probe.dataset.estado !== "pronto") return null;
      const linha = document.querySelector("[data-locum-orcamento]");
      const hoje = linha?.querySelector("[data-locum-hoje]");
      if (linha === null || hoje === undefined || hoje === null) return null;
      return {
        texto: (hoje.textContent ?? "").trim(),
        runs: Number(hoje.dataset.locumHoje),
        gasto: linha.dataset.locumGastoHoje,
      };
    })()`,
  );

  return {
    inbox: inbox.texto,
    pendencias: inbox.pendencias,
    execucoes: execucoes.texto,
    total: execucoes.total,
    agents: agents.texto,
    quantosAgents: agents.total,
    orcamento: orcamento.texto,
    execucoesDeHoje: orcamento.runs,
    gastoDeHoje: orcamento.gasto,
  };
}

/** Recarrega a página e espera ela terminar de carregar. */
async function recarregar(window: BrowserWindow): Promise<void> {
  const carregou = new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
  });
  window.webContents.reload();
  await carregou;
}

/**
 * Prova que a preferência de idioma manda na janela e que o texto muda com ela.
 *
 * A troca é pedida de dentro da página, pelo mesmo canal que a tela de
 * configuração vai usar, e não por chamada direta ao serviço deste lado: o que
 * interessa saber é que o caminho inteiro funciona, da janela até `settings` e
 * de volta. A página recarrega entre uma e outra de propósito: este exame prova
 * que a preferência sobrevive a uma subida, e não que a tela troca no lugar,
 * que é o que o `checkLanguagePicker` prova logo em seguida.
 *
 * O retorno padrão é conferido no serviço, com uma etiqueta de sistema que o
 * Locum não fala: a máquina do loop está num idioma só, e esperar que ela
 * esteja em alemão para exercitar o `en` seria um exame que nunca roda.
 */
async function checkI18n(window: BrowserWindow): Promise<string> {
  const { BRIDGE_GLOBAL } = await import("./bridge-contract.js");
  const { FALLBACK_LANGUAGE, i18nService, matchLanguage } = await import(
    "../src/services/i18n-service.js"
  );

  const original = await i18nService.getPreference();
  // O canal de trocar idioma agora mexe também na instância do processo
  // principal, que é a que escreve a linha final do smoke.
  const idiomaDoPrincipal = idiomaAtual();

  async function preferir(idioma: string | null): Promise<IdiomaVisto> {
    const argumento = idioma === null ? "null" : JSON.stringify(idioma);
    await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.i18n.setPreference(${argumento}).then(() => null)`,
    );
    await recarregar(window);
    return lerIdioma(window);
  }

  /** As quatro telas conferidas contra o dicionário do idioma que está valendo. */
  async function conferirTelas(dicionario: Dicionario, idioma: string): Promise<TelasVistas> {
    const telas = await lerTelas(window);
    const cobrar = (onde: string, visto: string, caminho: string, vars: Vars): void => {
      const esperado = doDicionario(dicionario, idioma, caminho, vars);
      if (visto !== esperado) {
        throw new Error(
          `${onde} em ${idioma} escreveu "${visto}" e o dicionario pede "${esperado}"`,
        );
      }
    };

    cobrar("a inbox", telas.inbox, "inbox.waiting", { count: telas.pendencias });
    cobrar("as execucoes", telas.execucoes, "runs.count", { count: telas.total });
    cobrar("a lista de agents", telas.agents, "agents.count", { count: telas.quantosAgents });
    cobrar("o orcamento", telas.orcamento, "settings.budgets.today", {
      count: telas.execucoesDeHoje,
      spent: Number(telas.gastoDeHoje).toFixed(3),
    });
    return telas;
  }

  try {
    const portugues = await preferir("pt-BR");
    if (portugues.idioma !== "pt-BR" || portugues.documento !== "pt-BR") {
      throw new Error(
        `a preferencia pt-BR deixou a janela em ${portugues.idioma} e o documento em ${portugues.documento}`,
      );
    }
    // A guarda de chave ausente segue `isPackaged`: em desenvolvimento ela
    // estoura para o buraco aparecer, e no pacote fica desligada para quem
    // instalou nao levar uma tela quebrada por causa de uma traducao faltando.
    // Conferir os dois lados importa porque o smoke roda das duas formas, e
    // exigir sempre ligada reprovaria o `.app` por estar certo.
    const estritoEsperado = String(!app.isPackaged);
    if (portugues.estrito !== estritoEsperado) {
      throw new Error(
        `a guarda de chave ausente esta ${portugues.estrito} e neste modo devia estar ${estritoEsperado}`,
      );
    }
    const esperadoPt = doDicionario(ptBR, "pt-BR", "bridge.runs", { count: portugues.runs });
    if (!portugues.rodape.includes(esperadoPt)) {
      throw new Error(`o rodape em pt-BR ficou "${portugues.rodape}" e devia trazer "${esperadoPt}"`);
    }
    const telasPt = await conferirTelas(ptBR, "pt-BR");

    const ingles = await preferir("en");
    if (ingles.idioma !== "en" || ingles.preferencia !== "en") {
      throw new Error(`a preferencia en deixou a janela em ${ingles.idioma}`);
    }
    const esperadoEn = doDicionario(en, "en", "bridge.runs", { count: ingles.runs });
    if (!ingles.rodape.includes(esperadoEn)) {
      throw new Error(`o rodape em en ficou "${ingles.rodape}" e devia trazer "${esperadoEn}"`);
    }
    if (ingles.rodape === portugues.rodape) {
      throw new Error(`o texto nao mudou de idioma, ficou "${ingles.rodape}" nos dois`);
    }
    const telasEn = await conferirTelas(en, "en");
    // Dicionário igual nos dois idiomas passaria pelas conferências acima sem
    // ninguém ter traduzido nada. A lista de execuções é a que prova: o plural
    // do português troca a palavra, e o da inbox pode coincidir com zero item.
    if (telasEn.execucoes === telasPt.execucoes) {
      throw new Error(`a lista de execucoes ficou "${telasEn.execucoes}" nos dois idiomas`);
    }

    // Sem preferencia, quem manda e a maquina, e o exame confere contra o que o
    // servico resolve para a etiqueta que o Electron devolveu.
    const doSistema = await preferir(null);
    const daMaquina = matchLanguage(app.getLocale()) ?? FALLBACK_LANGUAGE;
    if (doSistema.preferencia !== "" || doSistema.idioma !== daMaquina) {
      throw new Error(
        `sem preferencia a janela ficou em ${doSistema.idioma} e o sistema pede ${daMaquina}`,
      );
    }

    const desconhecido = await i18nService.resolve("de-DE");
    if (desconhecido.language !== FALLBACK_LANGUAGE) {
      throw new Error(`maquina em de-DE caiu em ${desconhecido.language} e nao no idioma base`);
    }

    const escolha = await checkLanguagePicker(window);

    return t("smoke.language", {
      pt: portugues.rodape,
      en: ingles.rodape,
      system: doSistema.idioma,
      fallback: FALLBACK_LANGUAGE,
      screens: t("smoke.screens", {
        agents: telasPt.agents,
        budget: telasPt.orcamento,
        inbox: telasPt.inbox,
        runs: telasPt.execucoes,
      }),
      picker: escolha,
    });
  } finally {
    // O exame escreve em `settings`, que sobrevive a ele. Sem isto, a proxima
    // subida do Locum nesta maquina abriria no idioma da ultima verificacao.
    await i18nService.setPreference(original);
    await aplicarIdioma(idiomaDoPrincipal);
  }
}

/** O botão de devolver a escolha ao sistema, que não é código de idioma. */
const SEGUIR_O_SISTEMA = "sistema";

/**
 * Prova que a seção de idioma da configuração troca tudo com um clique.
 *
 * O clique é no botão da tela, e não numa chamada ao canal: entre os dois está
 * justamente o que esta story entrega, que é a seção existir e estar ligada ao
 * provedor de idioma. Nada recarrega entre uma escolha e outra, e a prova
 * disso é uma marca deixada no `globalThis` da página, que uma recarga apagaria.
 *
 * A bandeja entra pelos rótulos montados em memória, como no `checkMainText`:
 * o que precisa ficar provado é que o processo principal virou de idioma na
 * mesma batida, e não que existe um ícone pendurado na barra do sistema.
 */
async function checkLanguagePicker(window: BrowserWindow): Promise<string> {
  const { trayMenuLabels } = await import("./tray.js");
  const { FALLBACK_LANGUAGE, matchLanguage } = await import("../src/services/i18n-service.js");

  const dicionarios: Record<string, Dicionario> = { en, "pt-BR": ptBR };

  await irPara(window, "configuracao");

  const rotulos: string[] = [];
  const daBandeja: string[] = [];

  for (const idioma of ["pt-BR", "en"]) {
    const visto = await escolherIdioma(window, idioma, idioma, dicionarios);

    if (visto.preferencia !== idioma) {
      throw new Error(
        `o clique em ${idioma} gravou a preferencia como "${visto.preferencia}"`,
      );
    }
    if (idiomaAtual() !== idioma) {
      throw new Error(
        `a janela foi para ${idioma} e o processo principal ficou em ${idiomaAtual()}`,
      );
    }

    // O item de abrir, que é frase curta e sem contagem: o que está sendo
    // provado aqui é o idioma da bandeja, e a contagem já tem exame próprio.
    const abrir = trayMenuLabels()[2] ?? "";
    const esperado = doDicionario(dicionarios[idioma] as Dicionario, idioma, "tray.open");
    if (abrir !== esperado) {
      throw new Error(
        `depois do clique em ${idioma} a bandeja ficou com "${abrir}" e o dicionario pede "${esperado}"`,
      );
    }

    rotulos.push(visto.rotulo);
    daBandeja.push(abrir);
  }

  if (rotulos[0] === rotulos[1] || daBandeja[0] === daBandeja[1]) {
    throw new Error(`o clique nao mudou o texto, ficou "${rotulos.join('" e "')}"`);
  }

  // Seguir o sistema não é escolher o idioma que o sistema fala agora: a
  // preferência sai de `settings`, e a máquina volta a mandar no dia em que
  // ela mudar de idioma.
  const daMaquina = matchLanguage(app.getLocale()) ?? FALLBACK_LANGUAGE;
  const sistema = await escolherIdioma(window, SEGUIR_O_SISTEMA, daMaquina, dicionarios);
  if (sistema.preferencia !== "" || sistema.ativo !== daMaquina) {
    throw new Error(
      `seguir o sistema deixou a tela em ${sistema.ativo} com a preferencia "${sistema.preferencia}"`,
    );
  }
  if (idiomaAtual() !== daMaquina) {
    throw new Error(`seguir o sistema deixou o processo principal em ${idiomaAtual()}`);
  }

  return t("smoke.picker", {
    pt: rotulos[0] ?? "",
    en: rotulos[1] ?? "",
    tray: daBandeja.join(" / "),
  });
}

interface EscolhaVista {
  ativo: string;
  preferencia: string;
  documento: string;
  rotulo: string;
  semRecarregar: boolean;
}

/**
 * Clica num botão da seção de idioma e espera a tela assentar no novo idioma.
 *
 * A espera é pelo texto, e não pelo atributo do marcador: o estado do React
 * chega um quadro antes do `changeLanguage` terminar, e conferir o atributo
 * aprovaria uma tela que mudou de idioma por dentro sem reescrever uma palavra.
 * O rótulo de seguir o sistema serve de amostra porque é o único da seção que
 * sai do dicionário: os outros são o nome de cada idioma nele mesmo.
 *
 * A preferência gravada entra na espera junto do texto, e não numa conferência
 * depois: numa máquina que já está no idioma escolhido nada no texto muda, e o
 * exame leria o estado anterior antes de o clique chegar a `settings`.
 */
async function escolherIdioma(
  window: BrowserWindow,
  alvo: string,
  idioma: string,
  dicionarios: Record<string, Dicionario>,
): Promise<EscolhaVista> {
  const esperado = doDicionario(
    dicionarios[idioma] as Dicionario,
    idioma,
    "settings.language.system",
  );
  // Seguir o sistema apaga a preferência, e o marcador escreve string vazia
  // onde ela não existe: atributo de dado não guarda nulo.
  const preferencia = alvo === SEGUIR_O_SISTEMA ? "" : alvo;

  const seletor = `[data-locum-idioma=${JSON.stringify(alvo)}]`;

  const clicou = (await window.webContents.executeJavaScript(
    `(() => {
      // Marca que uma recarga apagaria: a troca tem que acontecer na mesma
      // página, e não numa que subiu de novo por baixo do exame.
      globalThis.__locumSemRecarregar = true;
      const botao = document.querySelector(${JSON.stringify(seletor)});
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  )) as boolean;
  if (!clicou) throw new Error(`a secao de idioma nao tem botao para ${alvo}`);

  const visto = await esperarProbe<EscolhaVista>(
    window,
    "idioma-escolha",
    `(() => {
      const secao = document.querySelector("[data-locum-probe=idioma-escolha]");
      if (secao === null) return null;
      if (secao.dataset.locumIdiomaAtivo !== ${JSON.stringify(idioma)}) return null;
      if (secao.dataset.locumIdiomaPreferencia !== ${JSON.stringify(preferencia)}) return null;
      const sistema = secao.querySelector(${JSON.stringify(
        `[data-locum-idioma=${JSON.stringify(SEGUIR_O_SISTEMA)}]`,
      )});
      const rotulo = (sistema?.textContent ?? "").trim();
      if (rotulo !== ${JSON.stringify(esperado)}) return null;
      return {
        ativo: secao.dataset.locumIdiomaAtivo,
        preferencia: secao.dataset.locumIdiomaPreferencia,
        documento: document.documentElement.lang,
        rotulo,
        semRecarregar: globalThis.__locumSemRecarregar === true,
      };
    })()`,
  );

  if (!visto.semRecarregar) {
    throw new Error(`a troca para ${idioma} recarregou a janela em vez de trocar no lugar`);
  }
  if (visto.documento !== idioma) {
    throw new Error(`a tela foi para ${idioma} e o documento ficou marcado como ${visto.documento}`);
  }

  return visto;
}

/**
 * Prova que a bandeja e a notificação saem no idioma escolhido.
 *
 * Nada é pendurado na barra do sistema nem exibido: o menu é montado e lido em
 * memória, e a notificação nasce sem `show()`. O loop roda sem ninguém olhando,
 * e alerta na tela de quem estiver usando a máquina não é coisa que um exame
 * possa fazer.
 *
 * O esperado sai do arquivo de dicionário, e a comparação entre os dois idiomas
 * entra junto: texto igual nos dois significa tradução esquecida, que é
 * exatamente o que passa despercebido num menu que quase ninguém abre.
 */
async function checkMainText(): Promise<string> {
  const { trayMenuLabels, trayPendingCount } = await import("./tray.js");
  const { noticeText } = await import("./notify.js");
  const { promptDoSistema } = await import("./chat.js");

  const antes = idiomaAtual();
  const idiomas: [string, Dicionario][] = [
    ["pt-BR", ptBR],
    ["en", en],
  ];

  const aviso = {
    key: "critical_finding:run-smoke-texto",
    runId: "run-smoke-texto",
    kind: "critical_finding" as const,
    agentName: "pr-review",
    criticalCount: 3,
    at: 1_760_000_000,
  };

  const bandeja: string[] = [];
  const avisos: string[] = [];
  const prompts: string[] = [];

  try {
    for (const [idioma, dicionario] of idiomas) {
      await aplicarIdioma(idioma);

      // A contagem é a que a bandeja leu da fila mais cedo: o que está sendo
      // provado aqui é o idioma, e reler o banco só traria outra oportunidade
      // de a contagem mudar no meio do exame.
      const pendentes = trayPendingCount();
      const rotulos = trayMenuLabels();
      const esperados = [
        doDicionario(dicionario, idioma, "tray.pending", { count: pendentes }),
        "",
        doDicionario(dicionario, idioma, "tray.open"),
        doDicionario(dicionario, idioma, "tray.pause"),
        "",
        doDicionario(dicionario, idioma, "tray.quit"),
      ];
      if (rotulos.join("|") !== esperados.join("|")) {
        throw new Error(
          `a bandeja em ${idioma} montou "${rotulos.join("|")}" e o dicionario pede "${esperados.join("|")}"`,
        );
      }

      const texto = noticeText(aviso);
      const titulo = doDicionario(dicionario, idioma, "notification.criticalFinding.title", {
        agent: aviso.agentName,
        count: aviso.criticalCount,
      });
      const corpo = doDicionario(dicionario, idioma, "notification.criticalFinding.body", {
        count: aviso.criticalCount,
      });
      if (texto.title !== titulo || texto.body !== corpo) {
        throw new Error(
          `a notificacao em ${idioma} saiu como "${texto.title}" e "${texto.body}"`,
        );
      }

      // Run que falhou sem deixar mensagem: o corpo vem do dicionario. Com
      // mensagem ele sai como veio, porque a frase e do provedor.
      const semMensagem = noticeText({ ...aviso, kind: "run_failed", criticalCount: 0 });
      const esperadoSemMensagem = doDicionario(
        dicionario,
        idioma,
        "notification.runFailed.noError",
      );
      if (semMensagem.body !== esperadoSemMensagem) {
        throw new Error(`a falha sem mensagem em ${idioma} saiu como "${semMensagem.body}"`);
      }
      const comMensagem = noticeText({ ...aviso, kind: "run_failed", error: "socket hang up" });
      if (comMensagem.body !== "socket hang up") {
        throw new Error(`o erro do provedor foi reescrito para "${comMensagem.body}"`);
      }

      // O prompt de sistema do assistente e texto de produto, e a linha que
      // manda responder num idioma e a que decide o idioma da resposta. Sem
      // isto a tela viraria de idioma e o assistente continuaria respondendo
      // no anterior.
      const prompt = promptDoSistema();
      const esperadoPrompt = doDicionario(dicionario, idioma, "assistant.system");
      if (prompt !== esperadoPrompt) {
        throw new Error(`o prompt do assistente em ${idioma} nao saiu do dicionario`);
      }

      bandeja.push(rotulos[2] ?? "");
      avisos.push(texto.title);
      prompts.push(prompt.split("\n")[1] ?? "");
    }

    if (bandeja[0] === bandeja[1] || avisos[0] === avisos[1] || prompts[0] === prompts[1]) {
      throw new Error(`o texto do processo principal nao mudou de idioma: ${bandeja.join(", ")}`);
    }
  } finally {
    // O exame trocou o idioma da instância que a bandeja e a notificação usam
    // de verdade. Sem devolver, o resto do smoke sairia no último idioma visto.
    await aplicarIdioma(antes);
  }

  return t("smoke.mainText", {
    assistant: prompts.join(" / "),
    notification: avisos.join(" / "),
    tray: bandeja.join(" / "),
  });
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

/**
 * Poe o processo principal no idioma de quem esta na maquina.
 *
 * Qual idioma vale sai do mesmo servico que responde a janela, entao a bandeja
 * e a tela nunca discordam; o que a casca traz e so a etiqueta do sistema, que
 * e a unica parte que depende do Electron. Fora de app empacotado, chave
 * ausente estoura, como na janela: texto cru num menu da barra do sistema passa
 * despercebido por semanas.
 */
/**
 * Cria ou atualiza o esquema antes de qualquer serviço tocar o banco.
 *
 * Primeira coisa da subida, antes até do idioma: o dicionário sai de
 * `settings`, que é tabela, e numa máquina onde o Locum acabou de ser
 * instalado não existe tabela nenhuma. O `drizzle-kit push` que criava o
 * esquema é ferramenta de desenvolvimento e não viaja no pacote.
 *
 * A pasta vem por caminho explícito porque o migrator lê os `.sql` do disco:
 * o build copia `drizzle/` para junto do `main.cjs`, e é de lá que ela sai
 * tanto rodando por `npx electron dist/main.cjs` quanto empacotada.
 */
async function migrarEsquema(): Promise<import("../src/db/migrate.js").ResultadoDaMigracao> {
  const { migrateDb } = await import("../src/db/migrate.js");
  return migrateDb(join(__dirname, "drizzle"));
}

async function setupI18n(): Promise<string> {
  const { i18nService } = await import("../src/services/i18n-service.js");
  const { language } = await i18nService.resolve(app.getLocale());
  iniciarI18n({ idioma: language, estrito: !app.isPackaged });
  return language;
}

/**
 * Fotografa cada destino, para que a interface possa ser olhada e não só
 * descrita por linha de log.
 *
 * Nasceu de uma pergunta constrangedora: as telas foram construídas por
 * verificação automática, e ninguém tinha visto nenhuma delas. Critério
 * funcional não enxerga hierarquia, ritmo nem estado vazio.
 */
async function capturarTelas(janela: BrowserWindow): Promise<void> {
  const destino = flagValue("--capturas-em") ?? join(process.cwd(), "capturas");
  mkdirSync(destino, { recursive: true });
  janela.setSize(1280, 860);

  // O detalhe de execução e o assistente também entram: eles são metade do
  // aplicativo e não apareciam em captura nenhuma, que é como a lista de
  // execuções passou dias mostrando carimbo de máquina sem ninguém ver.
  // Importado aqui e não no topo: o módulo nativo do SQLite só carrega depois
  // que o processo aponta o binding compilado para o Electron, e um import de
  // topo puxaria o banco antes disso.
  const { runService } = await import("../src/services/run-service.js");
  const primeiroRun = (await runService.list({ limit: 1 }))[0]?.id;

  const { approvalService } = await import("../src/services/approval-service.js");
  const primeiraPendencia = (await approvalService.listPending())[0]?.id;

  const destinos: [string, string | undefined][] = [
    ["inbox", undefined],
    ["inbox", primeiraPendencia],
    ["execucoes", undefined],
    ["execucoes", primeiroRun],
    ["agents", undefined],
    ["configuracao", undefined],
  ];

  for (const [id, detalhe] of destinos) {
    await irPara(janela, id, detalhe);
    // A tela pede dado pela ponte ao montar, e fotografar antes da resposta
    // registraria o esqueleto em vez do conteúdo.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const imagem = await janela.webContents.capturePage();
    writeFileSync(join(destino, `${id}${detalhe ? "-detalhe" : ""}.png`), imagem.toPNG());
  }

  // O painel do assistente abre por atalho, então a captura usa o mesmo caminho.
  await irPara(janela, "inbox");
  await janela.webContents.executeJavaScript(
    `(() => {
      const evento = new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true });
      globalThis.dispatchEvent(evento);
      return null;
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  writeFileSync(join(destino, "assistente.png"), (await janela.webContents.capturePage()).toPNG());

  console.log(`capturas em ${destino}`);
}

async function main(): Promise<void> {
  await app.whenReady();

  // Antes de tudo que lê o banco, inclusive do idioma, que mora em `settings`.
  const esquema = await migrarEsquema();

  // Antes de qualquer texto: bandeja, notificacao e o proprio smoke falam pelo
  // dicionario, e pedir chave antes disso estoura de proposito.
  await setupI18n();

  if (esquema.criado) console.log(t("schema.created", { count: esquema.disponiveis }));
  else if (esquema.adotado) console.log(t("schema.adopted", { count: esquema.disponiveis }));

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
    const schema = t("smoke.schema", { count: esquema.disponiveis });

    const loginItem = await checkLoginItem();

    const tray = await setupTray({ openWindow: showWindow });
    const pending = await countPending();
    if (tray.isDestroyed()) throw new Error("bandeja nao sobreviveu a criacao");
    if (trayPendingCount() !== pending) {
      throw new Error(
        `bandeja marca ${trayPendingCount()} pendencia(s) e a fila tem ${pending}`,
      );
    }
    const mainText = await checkMainText();
    teardownTray();

    const power = await checkPower();
    const updates = await checkUpdates();
    const secrets = await checkSecrets();
    const avisos = await checkNotifications();
    const conferencia = await checkReconcile();
    const deepLink = await checkDeepLink();
    const ponte = await checkBridge();
    const renderer = await checkRenderer();

    console.log(
      t("smoke.ok", {
        agents,
        schema,
        pending,
        loginItem,
        power,
        updates,
        secrets,
        notifications: avisos,
        reconcile: conferencia,
        deepLink,
        bridge: ponte,
        renderer,
        mainText,
      }),
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
    console.log(
      t("loginItem.applied", { preference: startup.preference, status: startup.status }),
    );
  }

  await setupTray({ openWindow: showWindow });

  const { setupNotifications } = await import("./notify.js");
  const jaNaFila = await setupNotifications({ openInbox });
  if (jaNaFila > 0) console.log(`notificacao: ${jaNaFila} aviso(s) ja na fila, nenhum exibido`);

  const { setupPower } = await import("./power.js");
  setupPower();

  // Depois de tudo que o Locum precisa para funcionar: atualizar é o único
  // passo da subida que fala com a internet, e ele não pode atrasar a bandeja
  // nem a janela. Desligado, que é o padrão, não custa nada.
  const { setupUpdater } = await import("./updater.js");
  const atualizacao = await setupUpdater();
  if (atualizacao.armed) console.log(`atualização: verificando em ${atualizacao.feed}`);

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
