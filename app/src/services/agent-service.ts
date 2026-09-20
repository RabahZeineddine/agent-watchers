import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { AgentBudgetPatch, AgentSpec, type ActionMode } from "../config/types.js";
import { today } from "../executor/budget.js";

type Db = typeof defaultDb;

export type AgentRow = typeof schema.agents.$inferSelect;
export type AgentVersionRow = typeof schema.agentVersions.$inferSelect;

/** Resumo de um agent para a lista, já com o que ele usa e como acorda. */
export interface AgentOverview extends AgentRow {
  version: number;
  stepCount: number;
  actionCount: number;
  models: string[];
  toolCount: number;
  skillCount: number;
  budget: { perRunUsd?: number; perDayUsd?: number };
  triggers: { kind: string; enabled: boolean; config: unknown }[];
  lastRun: {
    id: string;
    status: string;
    endedAt: number | null;
    createdAt: number;
    costUsd: number;
    estimateUsd: number;
  } | null;
}

/** Quem esta gravando. Agent nao sobe modo de passo de acao; pessoa sobe. */
export type Actor = "human" | "agent";

/** Passo de acao que teve o modo rebaixado na gravacao. */
export interface ActionDowngrade {
  step: string;
  from: ActionMode;
  to: "approve";
}

/** Linha de versao com o spec ja validado, que e como o resto do sistema usa. */
export interface AgentVersion extends Omit<AgentVersionRow, "spec"> {
  spec: AgentSpec;
  /** Vazio quando nada foi rebaixado. */
  downgrades: ActionDowngrade[];
}

/** Teto de gasto de um agent, com o que ja foi consumido hoje. */
export interface AgentBudgetView {
  agentId: string;
  name: string;
  enabled: boolean;
  /** Versao de onde o teto saiu, ou nulo em agent sem versao gravada. */
  version: number | null;
  perRunUsd: number | null;
  perDayUsd: number | null;
  spentTodayUsd: number;
  runsToday: number;
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
   * O teto de gasto de cada agent e quanto ja foi gasto hoje.
   *
   * O teto sai da versao do topo, porque e de la que o executor le, e o gasto
   * sai de `usage_daily`, que e onde ele acumula. Juntar os dois e o que
   * responde a pergunta que interessa a quem administra, que nao e "qual o
   * limite" nem "quanto gastei", e sim "quanto falta".
   *
   * Sao tres consultas e nao uma por agent: perguntar pela versao do topo
   * dentro de um laco releria a tabela inteira a cada volta, e quem chama isto
   * quer a lista, nunca uma linha so.
   */
  async budgets(): Promise<AgentBudgetView[]> {
    const rows = await this.db.select().from(schema.agents);
    const versions = await this.db
      .select()
      .from(schema.agentVersions)
      .orderBy(desc(schema.agentVersions.version));
    const usage = await this.db
      .select()
      .from(schema.usageDaily)
      .where(eq(schema.usageDaily.day, today()));

    // As versoes chegam da mais nova para a mais velha, entao a primeira de
    // cada agent e a do topo e as seguintes nao substituem.
    const topo = new Map<string, AgentVersionRow>();
    for (const version of versions) {
      if (!topo.has(version.agentId)) topo.set(version.agentId, version);
    }
    const gasto = new Map(usage.map((u) => [u.agentId, u]));

    return rows.map((agent) => {
      const version = topo.get(agent.id);
      const budget = version ? AgentSpec.parse(version.spec).budget : {};
      const hoje = gasto.get(agent.id);
      return {
        agentId: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        version: version?.version ?? null,
        perRunUsd: budget.perRunUsd ?? null,
        perDayUsd: budget.perDayUsd ?? null,
        spentTodayUsd: hoje?.costUsd ?? 0,
        runsToday: hoje?.runs ?? 0,
      };
    });
  }

  /**
   * Grava o spec como versao nova. Spec identico ao topo devolve a versao que
   * ja existe: reeditar sem mudar nada nao pode inflar o historico nem
   * desconectar os runs antigos da versao que eles executaram.
   *
   * O `actor` decide se o spec pode subir o modo de um passo de acao. Um agent
   * nao pode: `approve` e o teto do que ele grava, e qualquer `draft` ou `auto`
   * que ele mande e rebaixado, com o rebaixamento devolvido na resposta.
   *
   * Sem essa trava o ADR 0002 seria contornavel em dois passos. O servidor MCP
   * nao expoe aprovacao, mas expoe `upsert_agent` e `run_agent`: gravar um passo
   * de acao em `auto` e mandar rodar publicaria sem clique nenhum. A regra nao e
   * "nao existe ferramenta de aprovar", e sim "nada sai sem uma pessoa ter dito
   * que sai", e e essa que precisa valer.
   */
  async upsert(
    spec: AgentSpec,
    note?: string,
    actor: Actor = "agent",
  ): Promise<AgentVersion> {
    const parsed = AgentSpec.parse(spec);
    const latest = await this.latestRow(parsed.id);
    const guarded = actor === "human" ? { spec: parsed, downgrades: [] } : demoteActions(parsed, latest?.spec);

    return this.write(guarded, latest, note);
  }

  private async write(
    guarded: { spec: AgentSpec; downgrades: ActionDowngrade[] },
    latest: AgentVersionRow | undefined,
    note?: string,
  ): Promise<AgentVersion> {
    const parsed = guarded.spec;
    if (latest && sameSpec(latest.spec, parsed)) {
      return { ...parseVersion(latest), downgrades: guarded.downgrades };
    }

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

    return { ...parseVersion(inserted!), downgrades: guarded.downgrades };
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

    // Mexer no orcamento nao mexe em passo de acao, entao nao ha o que rebaixar.
    return this.upsert({ ...latest.spec, budget }, note ?? "orcamento ajustado", "human");
  }

  /**
   * O que a lista de agents precisa mostrar sem abrir nenhum deles.
   *
   * Uma linha com nome e "habilitado" não responde nenhuma pergunta real: em
   * que modelo ele roda, de quanto em quanto tempo acorda, quanto gastou, se a
   * última execução deu certo. Montado aqui e não na janela porque seriam
   * quatro leituras por agent, e a regra de qual versão conta é desta camada.
   */
  async overview(): Promise<AgentOverview[]> {
    const linhas = await this.list();
    const gatilhos = await this.db.select().from(schema.triggers);

    return Promise.all(
      linhas.map(async (agent) => {
        const versao = await this.getLatestVersion(agent.id);
        const spec = versao?.spec;

        const modelos = [
          ...new Set(
            (spec?.steps ?? [])
              .filter((step): step is Extract<typeof step, { type: "model" }> => step.type === "model")
              .map((step) => step.model),
          ),
        ];

        const ferramentas = new Set<string>();
        for (const step of spec?.steps ?? []) {
          if (step.type !== "model") continue;
          for (const ref of step.tools ?? spec?.defaultTools ?? []) {
            ferramentas.add(`${ref.server}.${ref.tool}`);
          }
        }

        const [ultima] = await this.db
          .select({
            id: schema.runs.id,
            status: schema.runs.status,
            endedAt: schema.runs.endedAt,
            createdAt: schema.runs.createdAt,
            costUsd: schema.runs.costUsd,
            estimateUsd: schema.runs.estimateUsd,
          })
          .from(schema.runs)
          .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
          .where(eq(schema.agentVersions.agentId, agent.id))
          .orderBy(desc(schema.runs.createdAt))
          .limit(1);

        return {
          ...agent,
          version: versao?.version ?? 0,
          stepCount: spec?.steps.length ?? 0,
          actionCount: (spec?.steps ?? []).filter((s) => s.type === "action").length,
          models: modelos,
          toolCount: ferramentas.size,
          skillCount: spec?.skills.length ?? 0,
          budget: spec?.budget ?? {},
          triggers: gatilhos
            .filter((g) => g.agentId === agent.id)
            .map((g) => ({ kind: g.kind, enabled: g.enabled, config: g.config })),
          lastRun: ultima ?? null,
        };
      }),
    );
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
  return { ...row, spec: AgentSpec.parse(row.spec), downgrades: [] };
}

/**
 * Rebaixa para `approve` todo passo de acao que suba o modo em relacao ao que
 * ja estava gravado. Modo que a versao anterior ja tinha para aquele mesmo
 * passo passa: significa que uma pessoa autorizou antes, e reeditar outra parte
 * do spec nao pode derrubar essa autorizacao.
 */
function demoteActions(
  spec: AgentSpec,
  stored: AgentSpec | unknown,
): { spec: AgentSpec; downgrades: ActionDowngrade[] } {
  const previous = new Map<string, ActionMode>();
  const parsedStored = stored === undefined ? undefined : AgentSpec.safeParse(stored);
  if (parsedStored?.success) {
    for (const step of parsedStored.data.steps) {
      if (step.type === "action") previous.set(step.key, step.mode);
    }
  }

  const downgrades: ActionDowngrade[] = [];
  const steps = spec.steps.map((step) => {
    if (step.type !== "action" || step.mode === "approve") return step;
    if (previous.get(step.key) === step.mode) return step;

    downgrades.push({ step: step.key, from: step.mode, to: "approve" });
    return { ...step, mode: "approve" as const };
  });

  return { spec: { ...spec, steps }, downgrades };
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
