import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { ApprovalGate } from "./approval/gate.js";
import { Executor } from "./executor/executor.js";
import { McpRegistry, type McpServerConfig } from "./mcp/registry.js";
import { claudeCodeAvailable } from "./providers/registry.js";
import { ClaudeCodeRuntime } from "./runtimes/claude-code.js";
import { agentService } from "./services/agent-service.js";
import { NativeRuntime } from "./runtimes/native.js";
import type { Runtime } from "./runtimes/types.js";
import { fetchPr, githubReviewHandler, pollOpenPullRequests, type Finding } from "./sources/github.js";
import { fallbacksSemAssinatura, prReviewSpec } from "./seed/pr-review.js";
import { demoPr } from "./seed/demo-event.js";

const machineId = process.env.MACHINE_ID ?? "default";

/** v1 sem UI: cadastro de MCP vem daqui. Na v3 vem da tela de configuracao. */
const mcpServers: McpServerConfig[] = [];

function buildExecutor(): Executor {
  const configs = new Map(mcpServers.map((c) => [c.name, c]));
  const runtimes = new Map<string, Runtime>([["native", new NativeRuntime()]]);
  if (claudeCodeAvailable()) runtimes.set("claude-code", new ClaudeCodeRuntime(configs));

  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler()]]));
  return new Executor({ mcp: McpRegistry.fromList(mcpServers), runtimes, gate, machineId });
}

/** Garante a versao do agent semente e os fallbacks da maquina sem assinatura. */
async function seed(): Promise<string> {
  const version = await agentService.upsert(prReviewSpec, "seed");

  if (machineId !== "minha-maquina") {
    for (const f of fallbacksSemAssinatura) {
      await db
        .insert(schema.modelFallbacks)
        .values({ id: randomUUID(), machineId, ...f })
        .onConflictDoNothing();
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

  const executor = buildExecutor();
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

  const executor = buildExecutor();
  const runId = await executor.createRun(versionId, eventId);
  console.log(`run ${runId} (evento sintetico ${demoPr.repo}#${demoPr.pull})`);
  const status = await executor.execute(runId);
  await printRun(runId);
  console.log(`\nstatus: ${status}`);
}

async function printRun(runId: string): Promise<void> {
  const rows = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId));
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));

  console.log("");
  for (const s of rows.sort((a, b) => a.idx - b.idx)) {
    const model = s.modelUsed ?? "acao";
    const sub = s.substitutionReason ? ` (substituido)` : "";
    const secs = s.startedAt && s.endedAt ? `${s.endedAt - s.startedAt}s` : "-";
    console.log(
      ` ${String(s.idx + 1).padStart(2)}  ${s.name.padEnd(22)} ${s.status.padEnd(18)} ${model}${sub}  ${secs}  ${s.costUsd.toFixed(3)}`,
    );
    if (s.error) console.log(`     erro: ${s.error}`);
  }
  console.log(
    `\ncusto do run: ${(run?.costUsd ?? 0).toFixed(3)} USD cobrado` +
      ` · ${(run?.estimateUsd ?? 0).toFixed(3)} USD equivalente (assinatura nao cobra)`,
  );
  if (run?.error) console.log(`motivo da parada: ${run.error}`);

  const audit = rows.find((s) => s.stepKey === "audit");
  const findings = (audit?.output as { findings?: Finding[] } | null)?.findings ?? [];
  if (findings.length > 0) {
    console.log(`\nachados (${findings.length}):`);
    for (const f of findings) {
      console.log(` [${f.severity}] ${f.file ?? "geral"}${f.line ? `:${f.line}` : ""}  ${f.problem}`);
    }
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

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
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
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`uso: ${cmd} <approval-id>`);
      const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler()]]));
      await gate.decide(arg, cmd === "approve" ? "approved" : "rejected");
      console.log(`${arg} ${cmd === "approve" ? "aprovado e publicado" : "rejeitado"}`);
      break;
    }
    case "resume": {
      const ids = await executor().resumeAll();
      console.log(`${ids.length} run(s) retomado(s)`);
      break;
    }
    case "run":
      if (!arg) throw new Error("uso: run <run-id>");
      console.log(await executor().execute(arg));
      await printRun(arg);
      break;
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
          "  approve <id>             publica a acao",
          "  reject <id>              descarta",
          "  resume                   retoma runs interrompidos",
          "  run <run-id>             continua um run especifico",
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
