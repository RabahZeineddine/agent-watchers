import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { ApprovalGate } from "./approval/gate.js";
import { McpTransport } from "./config/types.js";
import { buildExecutor, machineId } from "./executor/build.js";
import { agentService } from "./services/agent-service.js";
import { mcpService } from "./services/mcp-service.js";
import { providerService } from "./services/provider-service.js";
import { runService, type RunSummary } from "./services/run-service.js";
import { githubReviewHandler, fetchPr, pollOpenPullRequests } from "./sources/github.js";
import { fallbacksSemAssinatura, prReviewSpec } from "./seed/pr-review.js";
import { demoPr } from "./seed/demo-event.js";

/** Garante a versao do agent semente e os fallbacks da maquina sem assinatura. */
async function seed(): Promise<string> {
  const version = await agentService.upsert(prReviewSpec, "seed");

  if (machineId !== "minha-maquina") {
    for (const f of fallbacksSemAssinatura) {
      await providerService.setFallback(machineId, f.fromModel, f.toModel, f.order);
    }
  }
  return version.id;
}

async function review(target: string): Promise<void> {
  const match = target.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) throw new Error('alvo invalido, use "owner/repo#123"');
  const [, owner, repo, num] = match;

  const versionId = await seed();
  const ctx = await fetchPr(owner!, repo!, Number(num));

  const eventId = randomUUID();
  await db
    .insert(schema.events)
    .values({
      id: eventId,
      source: "github",
      externalId: `pr:${ctx.repo}#${ctx.pull}:sha:${ctx.headSha}`,
      payload: ctx as object,
    })
    .onConflictDoNothing();

  const executor = await buildExecutor();
  const runId = await executor.createRun(versionId, eventId);
  console.log(`run ${runId} iniciado para ${ctx.repo}#${ctx.pull}`);

  const status = await executor.execute(runId);
  await printRun(runId);
  console.log(`\nstatus: ${status}`);
}

/** Fumaca sem credencial: evento sintetico com defeito plantado no diff. */
async function demo(): Promise<void> {
  const versionId = await seed();
  const eventId = randomUUID();
  await db
    .insert(schema.events)
    .values({
      id: eventId,
      source: "demo",
      externalId: `demo:${Date.now()}`,
      payload: demoPr as object,
    })
    .onConflictDoNothing();

  const executor = await buildExecutor();
  const runId = await executor.createRun(versionId, eventId);
  console.log(`run ${runId} (evento sintetico ${demoPr.repo}#${demoPr.pull})`);
  const status = await executor.execute(runId);
  await printRun(runId);
  console.log(`\nstatus: ${status}`);
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

async function inbox(): Promise<void> {
  const rows = await db
    .select()
    .from(schema.approvals)
    .where(eq(schema.approvals.status, "pending"));

  if (rows.length === 0) {
    console.log("nada pendente");
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${r.kind}  run ${r.runId}`);
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

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const arg = args[0];
  const executor = () => buildExecutor();

  switch (cmd) {
    case "seed":
      console.log(`versao ${await seed()}`);
      break;
    case "demo":
      await demo();
      break;
    case "review":
      if (!arg) throw new Error('uso: review owner/repo#123');
      await review(arg);
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
    case "providers":
      await providers();
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
      const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler()]]));
      await gate.decide(arg, cmd === "approve" ? "approved" : "rejected");
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
          "  providers                lista provedores, substituicoes e a resolucao de cada passo",
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
