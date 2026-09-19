import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { AgentBudgetPatch, AgentSpec } from "../config/types.js";

type Db = typeof defaultDb;

export type AgentRow = typeof schema.agents.$inferSelect;
export type AgentVersionRow = typeof schema.agentVersions.$inferSelect;

/** Linha de versao com o spec ja validado, que e como o resto do sistema usa. */
export interface AgentVersion extends Omit<AgentVersionRow, "spec"> {
  spec: AgentSpec;
}

/**
 * Cadastro de agents. Linha de comando, servidor MCP e interface passam por
 * aqui, porque a regra de versao imutavel precisa valer para os tres.
 */
export class AgentService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(): Promise<AgentRow[]> {
    return this.db.select().from(schema.agents);
  }

  async get(agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    return row;
  }

  async listVersions(agentId: string): Promise<AgentVersion[]> {
    const rows = await this.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId))
      .orderBy(desc(schema.agentVersions.version));
    return rows.map(parseVersion);
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | undefined> {
    const row = await this.latestRow(agentId);
    return row ? parseVersion(row) : undefined;
  }

  /**
   * Grava o spec como versao nova. Spec identico ao topo devolve a versao que
   * ja existe: reeditar sem mudar nada nao pode inflar o historico nem
   * desconectar os runs antigos da versao que eles executaram.
   */
  async upsert(spec: AgentSpec, note?: string): Promise<AgentVersion> {
    const parsed = AgentSpec.parse(spec);
    const latest = await this.latestRow(parsed.id);
    if (latest && sameSpec(latest.spec, parsed)) return parseVersion(latest);

    await this.db
      .insert(schema.agents)
      .values({ id: parsed.id, name: parsed.name })
      .onConflictDoUpdate({
        target: schema.agents.id,
        set: { name: parsed.name },
      });

    const [inserted] = await this.db
      .insert(schema.agentVersions)
      .values({
        id: randomUUID(),
        agentId: parsed.id,
        version: (latest?.version ?? 0) + 1,
        spec: parsed as unknown as object,
        note: note ?? null,
      })
      .returning();

    return parseVersion(inserted!);
  }

  /**
   * Ajusta o teto de gasto gravando versao nova.
   *
   * O orcamento mora no spec porque e de la que o executor le antes de cada
   * passo. Mexer nele e mexer no spec, entao vale a mesma regra de versao
   * imutavel: run antigo continua apontando para o teto sob o qual ele rodou.
   */
  async setBudget(
    agentId: string,
    patch: AgentBudgetPatch,
    note?: string,
  ): Promise<AgentVersion> {
    const parsed = AgentBudgetPatch.parse(patch);
    const latest = await this.getLatestVersion(agentId);
    if (!latest) throw new Error(`agent "${agentId}" nao cadastrado`);

    const budget = { ...latest.spec.budget };
    for (const key of ["perRunUsd", "perDayUsd"] as const) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (value === null) delete budget[key];
      else budget[key] = value;
    }

    return this.upsert({ ...latest.spec, budget }, note ?? "orcamento ajustado");
  }

  private async latestRow(agentId: string): Promise<AgentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId))
      .orderBy(desc(schema.agentVersions.version))
      .limit(1);
    return row;
  }
}

function parseVersion(row: AgentVersionRow): AgentVersion {
  return { ...row, spec: AgentSpec.parse(row.spec) };
}

/**
 * O lado gravado passa pelo zod antes da comparacao porque o JSON so bate se as
 * duas pontas tiverem a mesma ordem de chaves, e a ordem vem do parse. Spec
 * gravado por uma versao antiga do schema pode nao passar, e ai conta como
 * diferente, que e o desfecho certo: vale gravar de novo.
 */
function sameSpec(stored: unknown, spec: AgentSpec): boolean {
  const normalized = AgentSpec.safeParse(stored);
  if (!normalized.success) return false;
  return JSON.stringify(normalized.data) === JSON.stringify(spec);
}

export const agentService = new AgentService();
