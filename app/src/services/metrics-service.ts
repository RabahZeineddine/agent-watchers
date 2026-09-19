import { and, asc, desc, eq, gte, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { today } from "../executor/budget.js";

type Db = typeof defaultDb;

/** Janela medida de uma versao de agent, com o agent junto para dar contexto. */
export interface VersionMetrics {
  agentId: string;
  agentName: string;
  version: number;
  agentVersionId: string;
  /** Conjunto de skills daquela janela: sem ele a comparacao entre versoes mente. */
  skillSet: unknown;
  windowStart: number;
  windowEnd: number;
  findingCount: number;
  precision: number | null;
  agreement: number | null;
  missed: number;
}

export interface DailyUsage {
  day: string;
  agentId: string;
  costUsd: number;
  runs: number;
}

export interface MetricsReport {
  versions: VersionMetrics[];
  usage: DailyUsage[];
  /** Vazio enquanto o reconciliador nao rodar, e quem le precisa saber disso. */
  note?: string;
}

/**
 * Leitura das metricas por versao e do gasto diario.
 *
 * Aqui so se le. O reconciliador de review humano preenche o gabarito em
 * `finding_outcomes`, e a agregacao dele em `agent_metrics` e o N.2, entao ate
 * la a lista de versoes volta vazia e o gasto diario e a unica parte com dado.
 */
export class MetricsService {
  constructor(private readonly db: Db = defaultDb) {}

  async byVersion(agentId?: string): Promise<VersionMetrics[]> {
    const rows = await this.db
      .select({
        metric: schema.agentMetrics,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        version: schema.agentVersions.version,
      })
      .from(schema.agentMetrics)
      .innerJoin(
        schema.agentVersions,
        eq(schema.agentMetrics.agentVersionId, schema.agentVersions.id),
      )
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(agentId !== undefined ? eq(schema.agents.id, agentId) : undefined)
      .orderBy(desc(schema.agentVersions.version), asc(schema.agentMetrics.windowStart));

    return rows.map((r) => ({
      agentId: r.agentId,
      agentName: r.agentName,
      version: r.version,
      agentVersionId: r.metric.agentVersionId,
      skillSet: r.metric.skillSet,
      windowStart: r.metric.windowStart,
      windowEnd: r.metric.windowEnd,
      findingCount: r.metric.findingCount,
      precision: r.metric.precision,
      agreement: r.metric.agreement,
      missed: r.metric.missed,
    }));
  }

  /** Gasto por dia, do mais recente para tras. `days` conta a partir de hoje. */
  async usage(options: { agentId?: string; days?: number } = {}): Promise<DailyUsage[]> {
    const conditions: SQL[] = [];
    if (options.agentId !== undefined) {
      conditions.push(eq(schema.usageDaily.agentId, options.agentId));
    }
    if (options.days !== undefined) {
      conditions.push(gte(schema.usageDaily.day, daysAgo(options.days)));
    }

    return this.db
      .select()
      .from(schema.usageDaily)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.usageDaily.day));
  }

  async report(options: { agentId?: string; days?: number } = {}): Promise<MetricsReport> {
    const versions = await this.byVersion(options.agentId);
    const usage = await this.usage(options);
    return {
      versions,
      usage,
      note:
        versions.length === 0
          ? "nenhuma janela medida ainda: agent_metrics agrega os desfechos que o reconciliador grava"
          : undefined,
    };
  }
}

/**
 * Dia limite no mesmo formato que `usage_daily` guarda. A comparacao e de
 * texto, que so funciona porque o formato e ISO e tem largura fixa.
 */
function daysAgo(days: number): string {
  const ms = Date.parse(`${today()}T00:00:00Z`) - Math.max(0, days - 1) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export const metricsService = new MetricsService();
