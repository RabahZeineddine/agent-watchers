import { McpTransport } from "./config/types.js";
import { buildExecutor, buildGate } from "./executor/build.js";
import { agentService } from "./services/agent-service.js";
import { approvalService } from "./services/approval-service.js";
import { executionService } from "./services/execution-service.js";
import { machineId } from "./services/machine-service.js";
import { metricsService, type VersionMetrics } from "./services/metrics-service.js";
import { mcpService } from "./services/mcp-service.js";
import { providerService } from "./services/provider-service.js";
import { reconcileService } from "./services/reconcile-service.js";
import { runService, type RunSummary } from "./services/run-service.js";
import { secretService } from "./services/secret-service.js";
import { startupService } from "./services/startup-service.js";
import { triggerService } from "./services/trigger-service.js";
import { pollOpenPullRequests } from "./sources/github.js";
import { scheduler, type TickResult } from "./triggers/scheduler.js";
import { fallbacksSemAssinatura, prReviewSpec } from "./seed/pr-review.js";

/** Garante a versao do agent semente e os fallbacks da maquina sem assinatura. */
async function seed(): Promise<string> {
  const version = await agentService.upsert(prReviewSpec, "seed", "human");

  if (machineId !== "minha-maquina") {
    for (const f of fallbacksSemAssinatura) {
      await providerService.setFallback(machineId, f.fromModel, f.toModel, f.order);
    }
  }
  return version.id;
}

/** Roda o pipeline num alvo, real ou sintetico, e imprime o resultado. */
async function start(target: string): Promise<void> {
  await seed();
  const started = await executionService.start({ target });
  console.log(`run ${started.runId} (${started.source} ${started.repo}#${started.pull})`);

  await printRun(started.runId);
  console.log(`\nstatus: ${started.status}`);
}

async function printRun(runId: string): Promise<void> {
  const run = await runService.get(runId);
  if (!run) throw new Error(`run ${runId} nao encontrado`);

  console.log("");
  for (const s of run.steps) {
    const model = s.modelUsed ?? "acao";
    const sub = s.substitutionReason ? ` (substituido)` : "";
    const secs = s.startedAt && s.endedAt ? `${s.endedAt - s.startedAt}s` : "-";
    console.log(
      ` ${String(s.idx + 1).padStart(2)}  ${s.name.padEnd(22)} ${s.status.padEnd(18)} ${model}${sub}  ${secs}  ${s.costUsd.toFixed(3)}`,
    );
    if (s.error) console.log(`     erro: ${s.error}`);
  }
  console.log(
    `\ncusto do run: ${run.costUsd.toFixed(3)} USD cobrado` +
      ` \u00b7 ${run.estimateUsd.toFixed(3)} USD equivalente (assinatura nao cobra)`,
  );
  if (run.error) console.log(`motivo da parada: ${run.error}`);

  const findings = await runService.findings(runId);
  if (findings.length > 0) {
    console.log(`\nachados (${findings.length}):`);
    for (const f of findings) {
      console.log(` [${f.severity}] ${f.file ?? "geral"}${f.line ? `:${f.line}` : ""}  ${f.problem}`);
    }
  }
}

/** Ultimas execucoes, opcionalmente so as de um status. */
async function runs(status?: string): Promise<void> {
  const rows = await runService.list(status ? { status } : {});
  if (rows.length === 0) {
    console.log(status ? `nenhum run com status ${status}` : "nenhum run registrado");
    return;
  }
  for (const r of rows) console.log(formatRun(r));
}

function formatRun(run: RunSummary): string {
  const quando = new Date(run.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ");
  const agent = `${run.agentId} v${run.agentVersion}`;
  return `${run.id}  ${quando}  ${agent.padEnd(20)} ${run.status.padEnd(10)} ${run.costUsd.toFixed(3)} USD`;
}

/**
 * O que roda nesta maquina, a tabela de substituicao e onde cada passo do
 * agent semente cairia hoje.
 */
async function providers(): Promise<void> {
  for (const p of providerService.listProviders()) {
    const via = p.subscription ? "assinatura" : "api";
    const motivo = p.available
      ? ""
      : p.requires.length > 0
        ? `faltam ${p.requires.join(", ")}`
        : "binario claude ausente ou sessao expirada";
    console.log(` ${p.available ? " " : "-"} ${p.name.padEnd(12)} ${via.padEnd(10)} ${motivo}`);
  }

  const fallbacks = await providerService.getFallbacks(machineId);
  console.log(`\nsubstituicoes de ${machineId}:`);
  if (fallbacks.length === 0) console.log("  nenhuma");
  for (const f of fallbacks) console.log(`  ${f.fromModel} -> ${f.toModel} (ordem ${f.order})`);

  const modelos = [
    ...new Set(prReviewSpec.steps.filter((s) => s.type === "model").map((s) => s.model)),
  ];
  console.log("\npassos do agent semente:");
  for (const modelo of modelos) {
    const preview = await providerService.resolvePreview(modelo, machineId);
    console.log(
      preview.ok
        ? `  ${modelo} -> ${preview.resolution.used}${preview.resolution.substitutionReason ? " (substituido)" : ""}`
        : `  ${modelo} -> sem saida: ${preview.error}`,
    );
  }
}

/** Cruza o review humano com os achados do run e imprime o gabarito. */
async function reconcile(runId: string, force: boolean): Promise<void> {
  const report = await reconcileService.reconcileRun(runId, { force });
  console.log(`${report.prKey}  ${report.state}`);
  if (report.skipped) {
    console.log(`nada gravado: ${report.skipped}`);
    return;
  }
  console.log(`${report.findingCount} achado(s), ${report.signalCount} sinal(is) humano(s)`);
  for (const [estado, quantos] of Object.entries(report.outcomes)) {
    if (quantos > 0) console.log(`  ${estado.padEnd(20)} ${quantos}`);
  }
  console.log(`  ${"nao visto pelo agent".padEnd(20)} ${report.unmatchedSignals}`);
}

/**
 * Recalcula as janelas a partir do gabarito e imprime precisao por versao.
 *
 * Agrega antes de imprimir porque a tabela e derivada: sem recalcular, o
 * numero na tela seria o da ultima vez que alguem rodou isto.
 */
async function metrics(agentId?: string): Promise<void> {
  const versions = await metricsService.aggregate(agentId ? { agentId } : {});
  if (versions.length === 0) {
    console.log("nenhuma janela medida: rode reconcile para gravar os desfechos");
  }
  for (const v of versions) console.log(formatVersion(v));

  const usage = await metricsService.usage(agentId ? { agentId, days: 7 } : { days: 7 });
  if (usage.length > 0) {
    console.log("\ngasto dos ultimos 7 dias:");
    for (const u of usage) {
      console.log(`  ${u.day}  ${u.agentId.padEnd(20)} ${u.costUsd.toFixed(3)} USD  ${u.runs} run(s)`);
    }
  }
}

function formatVersion(v: VersionMetrics): string {
  const janela = [v.windowStart, v.windowEnd]
    .map((t) => new Date(t * 1000).toISOString().slice(0, 10))
    .join(" a ");
  const skills = v.skillSet.length > 0 ? v.skillSet.map((s) => s.name).join("+") : "sem skill";
  return (
    `${v.agentId} v${v.version}`.padEnd(22) +
    ` ${janela}  ${String(v.findingCount).padStart(3)} achado(s)` +
    `  precisao ${pct(v.precision)}  concordancia ${pct(v.agreement)}` +
    `  ${String(v.missed).padStart(3)} nao visto(s)  ${skills}`
  );
}

/** Sem desfecho que sustente a fracao, mostrar zero mentiria. */
function pct(value: number | null): string {
  return value === null ? "  n/d" : `${(value * 100).toFixed(0).padStart(3)}%`;
}

async function inbox(): Promise<void> {
  const rows = await approvalService.listPending();
  if (rows.length === 0) {
    console.log("nada pendente");
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${r.kind}  ${r.agentId} v${r.agentVersion} / ${r.stepName}  run ${r.runId}`);
    console.log(`   ${JSON.stringify(r.payload).slice(0, 200)}`);
  }
}

/** Lista os servidores cadastrados, marcando os que estao desligados. */
async function mcpList(): Promise<void> {
  const entries = await mcpService.list();
  if (entries.length === 0) {
    console.log("nenhum servidor MCP cadastrado");
    return;
  }
  for (const { config, enabled } of entries) {
    const alvo = config.transport === "stdio" ? config.command!.join(" ") : config.url!;
    console.log(
      `${enabled ? " " : "-"} ${config.name.padEnd(20)} ${config.transport.padEnd(6)} ${config.scope.padEnd(5)} ${alvo}`,
    );
  }
}

/** Catalogo do servidor, com o peso de cada ferramenta no contexto. */
async function mcpTools(name: string): Promise<void> {
  const tools = await mcpService.listTools(name);
  if (tools.length === 0) {
    console.log(`${name} nao expoe nenhuma ferramenta`);
    return;
  }
  for (const tool of tools) {
    console.log(`${tool.name.padEnd(20)} ~${String(tool.estimatedTokens).padStart(5)} tok  ${tool.description}`);
  }
  console.log(`${tools.length} ferramenta(s)`);
}

async function mcpTest(name: string): Promise<void> {
  const check = await mcpService.testConnection(name);
  if (check.ok) {
    console.log(`${name} ok em ${check.elapsedMs}ms, ${check.toolCount} ferramenta(s)`);
    return;
  }
  console.log(`${name} falhou em ${check.elapsedMs}ms: ${check.error}`);
  process.exitCode = 1;
}

/** Lista os gatilhos cadastrados e quando cada um quer a proxima batida. */
async function triggers(): Promise<void> {
  const list = await triggerService.list();
  if (list.length === 0) {
    console.log("nenhum gatilho cadastrado");
    return;
  }
  for (const t of list) {
    const estado = t.enabled ? "habilitado " : "desabilitado";
    console.log(`${t.id}  ${estado}  ${t.agentId}  ${JSON.stringify(t.config)}`);
  }
  const next = await scheduler.nextDueAt();
  console.log(`\nproxima batida: ${next === null ? "nenhuma" : new Date(next).toISOString()}`);
}

/** Uma batida do agendador. Quem repete e o sistema, nao um laco daqui. */
async function tick(wait: boolean): Promise<void> {
  const result: TickResult = await scheduler.tick({ wait });
  if (result.outcomes.length === 0) {
    console.log("nenhum gatilho habilitado");
    return;
  }
  for (const o of result.outcomes) {
    const detalhe = o.detail ? `  ${o.detail}` : "";
    console.log(
      `${o.status.padEnd(8)} ${o.kind.padEnd(9)} ${o.agentId}  ` +
        `${o.events} evento(s), ${o.runs.length} run(s)${detalhe}`,
    );
    for (const runId of o.runs) console.log(`         run ${runId}`);
  }
  console.log(
    `\nproxima batida: ${result.nextDueAt === null ? "nenhuma" : new Date(result.nextDueAt).toISOString()}`,
  );
}

/**
 * Estado da preferencia de subir junto com o login.
 *
 * A linha de comando so mexe no que esta guardado: quem fala com o item de
 * login do macOS e o processo do Electron, entao o que se grava aqui vale a
 * partir da proxima vez que o Locum subir.
 */
async function startup(decision: boolean | null): Promise<void> {
  if (decision !== null) await startupService.setPreference(decision);

  const preference = await startupService.getPreference();
  if (preference === null) {
    console.log("inicio no login: nao decidido, e o app nao liga sozinho");
    return;
  }
  console.log(
    `inicio no login: ${preference ? "ligado" : "desligado"}` +
      (decision === null ? "" : ", valendo na proxima vez que o Locum subir"),
  );
}

/**
 * O que esta guardado no cofre e quem aponta para la.
 *
 * Nenhum valor sai impresso, e pela linha de comando nem daria: o keychain so
 * abre dentro do app. Aqui se enxerga o endereco, nao o segredo.
 */
async function secrets(): Promise<void> {
  const guardados = secretService.list();
  console.log(
    secretService.available
      ? "cofre: legivel neste processo"
      : "cofre: so o app Electron le, aqui vale a variavel de ambiente",
  );

  const usos = new Map<string, string[]>();
  for (const [name, ref] of Object.entries(await providerService.credentialRefs())) {
    usos.set(ref, [...(usos.get(ref) ?? []), `provider ${name}`]);
  }
  for (const entry of await mcpService.list()) {
    if (!entry.credentialRef) continue;
    usos.set(entry.credentialRef, [...(usos.get(entry.credentialRef) ?? []), `mcp ${entry.config.name}`]);
  }

  console.log("\nguardados:");
  if (guardados.length === 0) console.log("  nenhum");
  for (const ref of guardados) {
    console.log(`  ${ref.padEnd(32)} ${usos.get(ref)?.join(", ") ?? "sem cadastro apontando"}`);
  }

  const orfaos = [...usos].filter(([ref]) => !secretService.has(ref));
  if (orfaos.length > 0) {
    console.log("\napontam para credencial que nao existe no cofre:");
    for (const [ref, quem] of orfaos) console.log(`  ${ref.padEnd(32)} ${quem.join(", ")}`);
  }
}

/** Liga ou desliga um cadastro de uma credencial do cofre. */
async function secretLink(alvo: string, ref: string | null): Promise<void> {
  const at = alvo.indexOf(":");
  const kind = at < 0 ? "" : alvo.slice(0, at);
  const name = alvo.slice(at + 1);
  if (kind !== "provider" && kind !== "mcp") {
    throw new Error("alvo invalido, use provider:<nome> ou mcp:<nome>");
  }

  if (kind === "provider") await providerService.setCredentialRef(name, ref);
  else await mcpService.setCredentialRef(name, ref);

  console.log(ref === null ? `${alvo} desvinculado` : `${alvo} aponta para ${ref}`);
  if (ref !== null && !secretService.has(ref)) {
    console.log(`nada guardado em ${ref} ainda: grave com "electron dist/main.cjs --set-secret ${ref}"`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = args[0];
  const executor = () => buildExecutor();

  switch (cmd) {
    case "seed":
      console.log(`versao ${await seed()}`);
      break;
    case "demo":
      await start("sintetico");
      break;
    case "review":
      if (!arg) throw new Error('uso: review owner/repo#123');
      await start(arg);
      break;
    case "poll": {
      const owner = process.env.GITHUB_OWNER;
      if (!owner) throw new Error("GITHUB_OWNER ausente");
      const ids = await pollOpenPullRequests(owner, new RegExp(arg ?? ".*"));
      console.log(`${ids.length} evento(s) novo(s)`);
      break;
    }
    case "inbox":
      await inbox();
      break;
    case "runs":
      await runs(arg);
      break;
    case "reconcile": {
      if (!arg) throw new Error("uso: reconcile <run-id> [--force]");
      await reconcile(arg, args.includes("--force"));
      break;
    }
    case "metrics":
      await metrics(arg);
      break;
    case "triggers":
      await triggers();
      break;
    case "tick":
      await tick(args.includes("--wait"));
      break;
    case "providers":
      await providers();
      break;
    case "startup":
      await startup(null);
      break;
    case "startup:on":
      await startup(true);
      break;
    case "startup:off":
      await startup(false);
      break;
    case "secrets":
      await secrets();
      break;
    case "secret:link": {
      const [alvo, ref] = args;
      if (!alvo || !ref) throw new Error("uso: secret:link <provider|mcp>:<nome> <escopo/nome>");
      await secretLink(alvo, ref);
      break;
    }
    case "secret:unlink":
      if (!arg) throw new Error("uso: secret:unlink <provider|mcp>:<nome>");
      await secretLink(arg, null);
      break;
    case "mcp":
      await mcpList();
      break;
    case "mcp:register": {
      const [name, rawTransport, alvo] = args;
      if (!name || !rawTransport || !alvo) {
        throw new Error("uso: mcp:register <nome> <stdio|http|sse> <comando-ou-url>");
      }
      const transport = McpTransport.safeParse(rawTransport);
      if (!transport.success) throw new Error("transporte invalido, use stdio, http ou sse");

      // O comando chega como uma string so para caber em um argumento de shell.
      const { config } = await mcpService.register({
        name,
        transport: transport.data,
        ...(transport.data === "stdio" ? { command: alvo.split(/\s+/) } : { url: alvo }),
      });
      console.log(`${config.name} cadastrado (${config.transport})`);
      break;
    }
    case "mcp:tools":
      if (!arg) throw new Error("uso: mcp:tools <nome>");
      await mcpTools(arg);
      break;
    case "mcp:test":
      if (!arg) throw new Error("uso: mcp:test <nome>");
      await mcpTest(arg);
      break;
    case "mcp:remove":
      if (!arg) throw new Error("uso: mcp:remove <nome>");
      console.log((await mcpService.remove(arg)) ? `${arg} removido` : `${arg} nao estava cadastrado`);
      break;
    case "mcp:enable":
    case "mcp:disable": {
      if (!arg) throw new Error(`uso: ${cmd} <nome>`);
      await mcpService.setEnabled(arg, cmd === "mcp:enable");
      console.log(`${arg} ${cmd === "mcp:enable" ? "habilitado" : "desabilitado"}`);
      break;
    }
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`uso: ${cmd} <approval-id>`);
      await buildGate().decide(arg, cmd === "approve" ? "approved" : "rejected");
      console.log(`${arg} ${cmd === "approve" ? "aprovado e publicado" : "rejeitado"}`);
      break;
    }
    case "resume": {
      const ids = await (await executor()).resumeAll();
      console.log(`${ids.length} run(s) retomado(s)`);
      break;
    }
    case "run":
      if (!arg) throw new Error("uso: run <run-id>");
      console.log(await (await executor()).execute(arg));
      await printRun(arg);
      break;
    case "rerun": {
      const [runId, stepKey] = args;
      if (!runId || !stepKey) throw new Error("uso: rerun <run-id> <chave-do-passo>");
      console.log(await runService.rerunStep(runId, stepKey));
      await printRun(runId);
      break;
    }
    default:
      console.log(
        [
          "uso: pnpm dev <comando>",
          "",
          "  seed                     grava a versao do agent semente",
          "  demo                     roda o pipeline num PR sintetico, sem credencial",
          "  review owner/repo#123    roda o pipeline num PR especifico",
          "  poll [regex-de-repo]     varre PRs abertos da org e cria eventos",
          "  inbox                    lista aprovacoes pendentes",
          "  runs [status]            lista as ultimas execucoes",
          "  reconcile <run-id>       cruza o review humano com os achados e grava os desfechos",
          "  metrics [agent-id]       recalcula e imprime precisao por versao de agent",
          "  triggers                 lista os gatilhos e quando o agendador quer a proxima batida",
          "  tick [--wait]            uma batida do agendador nos gatilhos habilitados",
          "  providers                lista provedores, substituicoes e a resolucao de cada passo",
          "  startup                  mostra se o Locum sobe junto com o login",
          "  startup:on               passa a subir no login a partir da proxima subida",
          "  startup:off              deixa de subir no login",
          "  secrets                  credenciais guardadas no cofre e quem aponta para elas",
          "  secret:link <provider|mcp>:<nome> <escopo/nome>",
          "  secret:unlink <provider|mcp>:<nome>",
          "  mcp                      lista os servidores MCP cadastrados",
          "  mcp:register <nome> <transporte> <comando-ou-url>",
          "  mcp:tools <nome>         lista as ferramentas que o servidor expoe",
          "  mcp:test <nome>          conecta no servidor e informa o resultado",
          "  mcp:remove <nome>        tira o servidor do cadastro",
          "  mcp:enable <nome>        volta a expor o servidor ao executor",
          "  mcp:disable <nome>       tira o servidor do executor sem apagar",
          "  approve <id>             publica a acao",
          "  reject <id>              descarta",
          "  resume                   retoma runs interrompidos",
          "  run <run-id>             continua um run especifico",
          "  rerun <run-id> <passo>   zera o passo e os que dependem dele, e roda de novo",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
