import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import type { TriggerConfig } from "../config/types.js";
import { McpRegistry } from "../mcp/registry.js";
import { executionService, type ExecutionService } from "../services/execution-service.js";
import { mcpService, type McpService } from "../services/mcp-service.js";
import { triggerService, type TriggerEntry, type TriggerService } from "../services/trigger-service.js";
import { pollOpenPullRequests } from "../sources/github.js";

type Db = typeof defaultDb;

/** Fonte do cursor de tempo. Uma linha por gatilho, guardando o ultimo disparo. */
const CURSOR_SOURCE = "scheduler";

/**
 * De onde veio a batida. `wake` e o que o M3 vai mandar quando o Mac acordar,
 * e esta aqui desde ja para que o registro de uma batida longa depois de sono
 * nao pareca atraso do agendador.
 */
export type WakeReason = "manual" | "timer" | "wake";

export type TriggerStatus = "fired" | "waiting" | "skipped" | "failed";

export interface TriggerOutcome {
  triggerId: string;
  agentId: string;
  kind: TriggerConfig["kind"];
  status: TriggerStatus;
  /** Motivo de nao ter disparado, ou o erro de quem tentou e nao conseguiu. */
  detail?: string;
  /** Eventos novos que a varredura trouxe nesta batida. */
  events: number;
  /** Runs criados nesta batida. Vazio quando nao havia evento novo. */
  runs: string[];
  /** Quando este gatilho quer ser acordado de novo, em epoch de milissegundos. */
  nextDueAt: number | null;
}

export interface TickResult {
  at: number;
  reason: WakeReason;
  outcomes: TriggerOutcome[];
  /** A batida mais proxima que algum gatilho pediu. Nulo quando nao ha nenhum. */
  nextDueAt: number | null;
}

export interface TickOptions {
  /** Relogio da batida. Existe para teste, e para reproduzir uma batida antiga. */
  at?: number;
  reason?: WakeReason;
  /** Verdadeiro segura a batida ate o pipeline acabar. Padrao e soltar. */
  wait?: boolean;
}

/** A varredura do GitHub entra como dependencia para poder ser trocada em teste. */
export type PollFn = (owner: string, repoFilter: RegExp) => Promise<string[]>;

/**
 * Quem acorda os gatilhos habilitados.
 *
 * Anda por cursor de tempo, um por gatilho, e nao por janela fixa. A diferenca
 * aparece quando o Mac dorme: um `setInterval` de quinze minutos perde a janela
 * inteira e so volta a contar do zero ao acordar, enquanto o cursor guarda o
 * ultimo disparo e a primeira batida depois do sono ja encontra o gatilho
 * vencido. Por isso esta classe nao tem relogio proprio: ela e batida de fora,
 * pela linha de comando hoje e pelos eventos de energia do M3 depois, e devolve
 * em `nextDueAt` quando quer a proxima batida para quem a chama armar um
 * temporizador so.
 *
 * Disparar gatilho nao publica nada: o passo de acao continua parando na fila
 * de aprovacao, que segue fora de qualquer caminho automatico conforme o ADR
 * 0002.
 */
export class Scheduler {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly triggers: TriggerService = triggerService,
    private readonly executions: ExecutionService = executionService,
    private readonly mcp: McpService = mcpService,
    private readonly poll: PollFn = pollOpenPullRequests,
  ) {}

  /** Batida vinda do evento de acordar da maquina, que o M3 vai ligar. */
  async onWake(): Promise<TickResult> {
    return this.tick({ reason: "wake" });
  }

  async tick(options: TickOptions = {}): Promise<TickResult> {
    const at = options.at ?? Date.now();
    const reason = options.reason ?? "manual";
    const outcomes: TriggerOutcome[] = [];

    for (const trigger of await this.triggers.enabled()) {
      outcomes.push(await this.runTrigger(trigger, at, options.wait ?? false));
    }

    const due = outcomes.map((o) => o.nextDueAt).filter((v): v is number => v !== null);
    return { at, reason, outcomes, nextDueAt: due.length > 0 ? Math.min(...due) : null };
  }

  /** Quando o agendador quer ser acordado, sem disparar nada agora. */
  async nextDueAt(): Promise<number | null> {
    const times: number[] = [];
    for (const trigger of await this.triggers.enabled()) {
      const cadence = cadenceMs(trigger.config);
      if (cadence === null) continue;
      const last = await this.lastFire(trigger.id);
      times.push(last === null ? 0 : last + cadence);
    }
    return times.length > 0 ? Math.min(...times) : null;
  }

  private async runTrigger(
    trigger: TriggerEntry,
    at: number,
    wait: boolean,
  ): Promise<TriggerOutcome> {
    const base = {
      triggerId: trigger.id,
      agentId: trigger.agentId,
      kind: trigger.config.kind,
      events: 0,
      runs: [] as string[],
    };

    const cadence = cadenceMs(trigger.config);
    if (cadence === null) {
      return {
        ...base,
        status: "skipped",
        detail: "gatilho de webhook nao depende do relogio, quem dispara e a chamada",
        nextDueAt: null,
      };
    }

    const last = await this.lastFire(trigger.id);
    if (last !== null && at < last + cadence) {
      return { ...base, status: "waiting", nextDueAt: last + cadence };
    }

    const nextDueAt = at + cadence;
    try {
      const fired = await this.fire(trigger, wait);
      // O cursor avanca depois do disparo, mas avanca tambem quando o disparo
      // falha: o que protege evento de se perder e o cursor da propria fonte,
      // que nao andou. Sem isso, um gatilho quebrado tomaria todas as batidas
      // seguintes tentando de novo e abafaria os outros.
      await this.markFired(trigger.id, at);
      return { ...base, ...fired, status: "fired", nextDueAt };
    } catch (err) {
      await this.markFired(trigger.id, at);
      return { ...base, status: "failed", detail: message(err), nextDueAt };
    }
  }

  private async fire(
    trigger: TriggerEntry,
    wait: boolean,
  ): Promise<{ events: number; runs: string[]; detail?: string }> {
    const config = trigger.config;

    switch (config.kind) {
      case "schedule": {
        // Gatilho de relogio nao tem evento: o agent que roda por cadencia
        // busca o proprio contexto pelas ferramentas do passo.
        const { runId } = await this.executions.startForEvent({
          eventId: null,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          wait,
        });
        return { events: 0, runs: [runId] };
      }

      case "poll": {
        if (config.source !== "github") {
          throw new Error(`fonte "${config.source}" nao tem varredura cadastrada`);
        }
        const owner = process.env.GITHUB_OWNER;
        if (!owner) throw new Error("GITHUB_OWNER ausente, a varredura do GitHub precisa da org");

        const created = await this.poll(owner, new RegExp(config.repoMatch));
        const runs = await this.runsFor(trigger, created, wait);
        return { events: created.length, runs };
      }

      case "mcp-poll": {
        const result = await this.callServer(config.server, config.tool, config.args);
        // A chave do evento e o conteudo do resultado, entao varredura que volta
        // igual a anterior nao cria evento e nao vira run. E o mesmo contrato da
        // varredura do GitHub, onde o commit entra na chave.
        const { id, created } = await this.executions.recordEvent(
          `mcp:${config.server}`,
          `${config.tool}:${digest(result)}`,
          { server: config.server, tool: config.tool, args: config.args, result },
        );
        const runs = await this.runsFor(trigger, created ? [id] : [], wait);
        return { events: created ? 1 : 0, runs };
      }

      default:
        // `runTrigger` ja devolveu o webhook antes de chegar aqui. Se um tipo
        // novo entrar no zod e nao passar por este switch, e melhor estourar do
        // que acordar o agent de um jeito que ninguem desenhou.
        throw new Error(`gatilho do tipo "${(config as TriggerConfig).kind}" nao tem disparo`);
    }
  }

  /**
   * Um run por evento que este gatilho ainda nao rodou.
   *
   * A varredura ja deduplica por chave externa, mas a checagem contra `runs`
   * cobre o caso em que a batida anterior gravou o evento e morreu antes de
   * criar o run: o evento nao e novo, e ainda assim ninguem o processou.
   */
  private async runsFor(
    trigger: TriggerEntry,
    eventIds: string[],
    wait: boolean,
  ): Promise<string[]> {
    const runs: string[] = [];
    for (const eventId of eventIds) {
      if (await this.alreadyRan(trigger.id, eventId)) continue;
      const { runId } = await this.executions.startForEvent({
        eventId,
        agentId: trigger.agentId,
        triggerId: trigger.id,
        wait,
      });
      runs.push(runId);
    }
    return runs;
  }

  private async alreadyRan(triggerId: string, eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.triggerId, triggerId), eq(schema.runs.eventId, eventId)))
      .limit(1);
    return row !== undefined;
  }

  /** Sobe o servidor cadastrado so para esta chamada e o devolve encerrado. */
  private async callServer(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const configs = await this.mcp.enabledConfigs();
    const registry = McpRegistry.fromList(configs);
    if (!registry.has(server)) throw new Error(`servidor MCP "${server}" nao esta habilitado`);
    try {
      return await registry.callTool(server, tool, args);
    } finally {
      await registry.closeAll();
    }
  }

  private async lastFire(triggerId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ value: schema.cursors.value })
      .from(schema.cursors)
      .where(and(eq(schema.cursors.source, CURSOR_SOURCE), eq(schema.cursors.key, triggerId)));
    if (!row) return null;

    const parsed = Date.parse(row.value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private async markFired(triggerId: string, at: number): Promise<void> {
    await this.db
      .insert(schema.cursors)
      .values({ source: CURSOR_SOURCE, key: triggerId, value: new Date(at).toISOString() })
      .onConflictDoUpdate({
        target: [schema.cursors.source, schema.cursors.key],
        set: { value: new Date(at).toISOString(), updatedAt: Math.floor(at / 1000) },
      });
  }
}

/** Cadencia em milissegundos. Nulo e gatilho que nao anda pelo relogio. */
function cadenceMs(config: TriggerConfig): number | null {
  return config.kind === "webhook" ? null : config.everyMinutes * 60_000;
}

/**
 * Chave estavel do resultado de uma ferramenta. O corpo inteiro nao serve de
 * identificador externo porque nao tem limite de tamanho.
 */
function digest(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const scheduler = new Scheduler();
