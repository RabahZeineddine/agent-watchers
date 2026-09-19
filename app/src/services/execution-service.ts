import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { buildExecutor } from "../executor/build.js";
import { demoPr } from "../seed/demo-event.js";
import { prReviewSpec } from "../seed/pr-review.js";
import { fetchPr, type PrContext } from "../sources/github.js";
import { agentService, AgentService } from "./agent-service.js";

type Db = typeof defaultDb;

export type RunStatus = "queued" | "done" | "paused" | "failed";

/** Alvo real do GitHub ou o evento sintetico, que nao precisa de credencial. */
export type RunTarget =
  | { kind: "github"; owner: string; repo: string; pull: number }
  | { kind: "synthetic" };

export interface StartInput {
  /** Objeto ja resolvido ou o texto "owner/repo#123" ou "sintetico". */
  target: RunTarget | string;
  /** Ausente usa o agent semente, que e o unico cadastrado por padrao. */
  agentId?: string;
  /** Falso devolve assim que o run existe e deixa a execucao correndo atras. */
  wait?: boolean;
}

export interface StartedRun {
  runId: string;
  agentId: string;
  agentVersion: number;
  eventId: string;
  source: string;
  repo: string;
  pull: number;
  status: RunStatus;
}

/** O minimo do executor que este servico usa, para poder trocar em teste. */
export interface RunStarter {
  createRun(agentVersionId: string, eventId: string | null): Promise<string>;
  execute(runId: string): Promise<"done" | "paused" | "failed">;
}

const SINTETICO = new Set(["demo", "sintetico", "synthetic"]);

/**
 * Disparo de execucao a partir de um alvo.
 *
 * Linha de comando e servidor MCP passam por aqui porque a sequencia de ingerir
 * o evento, achar a versao do agent e criar o run tem uma armadilha no meio: o
 * evento e deduplicado pela origem, entao o mesmo pull request no mesmo commit
 * nao gera linha nova e o run precisa apontar para a que ja existe.
 *
 * Disparar execucao nao publica nada. O passo de acao continua parando na fila
 * de aprovacao, que segue fora do servidor MCP conforme o ADR 0002.
 */
export class ExecutionService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly agents: AgentService = agentService,
    private readonly makeRunner: () => Promise<RunStarter> = buildExecutor,
  ) {}

  async start(input: StartInput): Promise<StartedRun> {
    const target = typeof input.target === "string" ? parseTarget(input.target) : input.target;
    const version = await this.versionFor(input.agentId);

    const source = target.kind === "github" ? "github" : "demo";
    const context =
      target.kind === "github" ? await fetchPr(target.owner, target.repo, target.pull) : demoPr;
    const eventId = await this.recordEvent(source, externalId(source, context), context);

    const runner = await this.makeRunner();
    const runId = await runner.createRun(version.id, eventId);

    const started = {
      runId,
      agentId: version.agentId,
      agentVersion: version.version,
      eventId,
      source,
      repo: context.repo,
      pull: context.pull,
    };

    if (input.wait === false) {
      // O executor grava o desfecho no banco mesmo quando falha, entao soltar a
      // promessa nao perde informacao: quem chamou acompanha pelo run. Um
      // cliente MCP nao pode ficar minutos preso esperando o pipeline acabar.
      void runner.execute(runId).catch(() => undefined);
      return { ...started, status: "queued" };
    }

    return { ...started, status: await runner.execute(runId) };
  }

  private async versionFor(agentId?: string) {
    const id = agentId ?? prReviewSpec.id;
    const version = await this.agents.getLatestVersion(id);
    if (!version) throw new Error(`agent "${id}" nao tem versao gravada, rode seed antes`);
    return version;
  }

  /**
   * Grava o evento e devolve o identificador que vale, seja o novo ou o da
   * linha que ja estava la. Apontar o run para um identificador descartado pela
   * deduplicacao quebraria a chave estrangeira de `runs`.
   */
  private async recordEvent(source: string, external: string, payload: object): Promise<string> {
    const [inserted] = await this.db
      .insert(schema.events)
      .values({ id: randomUUID(), source, externalId: external, payload })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted.id;

    const [existing] = await this.db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.source, source), eq(schema.events.externalId, external)));
    if (!existing) throw new Error(`evento ${source}/${external} nao pode ser gravado`);
    return existing.id;
  }
}

/** Aceita "owner/repo#123" e os apelidos do evento sintetico. */
export function parseTarget(text: string): RunTarget {
  const trimmed = text.trim();
  if (SINTETICO.has(trimmed.toLowerCase())) return { kind: "synthetic" };

  const match = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) {
    throw new Error(`alvo invalido "${text}", use "owner/repo#123" ou "sintetico"`);
  }
  return { kind: "github", owner: match[1]!, repo: match[2]!, pull: Number(match[3]) };
}

/**
 * O commit entra na chave do evento real para que um push novo no mesmo pull
 * request valha como evento novo. O sintetico usa o relogio, porque ele existe
 * justamente para ser disparado de novo.
 */
function externalId(source: string, context: PrContext): string {
  return source === "github"
    ? `pr:${context.repo}#${context.pull}:sha:${context.headSha}`
    : `demo:${Date.now()}`;
}

export const executionService = new ExecutionService();
