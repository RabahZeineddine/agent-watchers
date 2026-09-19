import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import {
  buildProviders,
  resolveModel,
  splitModelId,
  type FallbackRow,
  type ModelResolution,
  type ProviderEntry,
} from "../providers/registry.js";

type Db = typeof defaultDb;

/** Um provider como ele aparece para quem administra esta maquina. */
export interface ProviderInfo {
  name: string;
  available: boolean;
  /** Via de assinatura: gasta o plano e nao expoe modelo de API. */
  subscription: boolean;
  /** Variaveis de ambiente que faltam quando o provider esta indisponivel. */
  requires: string[];
}

/**
 * Previa de resolucao. A falha vem como dado porque a pergunta "este modelo
 * roda aqui?" tem nao como resposta legitima, e quem pergunta quer ver o
 * motivo na tela em vez de receber um erro subindo a pilha.
 */
export type ModelPreview =
  | { ok: true; resolution: ModelResolution }
  | { ok: false; requested: string; error: string };

/**
 * Provedores de modelo e a tabela de substituicao por maquina. Linha de
 * comando, servidor MCP e interface passam por aqui, porque a deteccao de
 * ciclo na gravacao precisa valer para os tres: uma cadeia circular so
 * apareceria no meio de um run, horas depois de ter sido cadastrada.
 */
export class ProviderService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly providers: Record<string, ProviderEntry> = buildProviders(),
  ) {}

  listProviders(): ProviderInfo[] {
    return Object.entries(this.providers).map(([name, entry]) => ({
      name,
      available: entry.available(),
      subscription: entry.model === undefined,
      requires: entry.requires,
    }));
  }

  isAvailable(name: string): boolean {
    return this.providers[name]?.available() ?? false;
  }

  async getFallbacks(machineId: string): Promise<FallbackRow[]> {
    const rows = await this.db
      .select()
      .from(schema.modelFallbacks)
      .where(eq(schema.modelFallbacks.machineId, machineId))
      .orderBy(asc(schema.modelFallbacks.order));
    return rows.map((row) => ({
      fromModel: row.fromModel,
      toModel: row.toModel,
      order: row.order,
    }));
  }

  /**
   * Cadastra a substituicao, ou so reordena a que ja existe. Repetir o mesmo
   * par nao cria linha nova: o par e a identidade da aresta, e o seed roda a
   * cada execucao. A tabela nao tem unicidade no banco, entao a limpeza do par
   * acontece aqui, o que tambem colapsa as copias que versoes anteriores
   * deixaram para tras.
   */
  async setFallback(
    machineId: string,
    fromModel: string,
    toModel: string,
    order = 0,
  ): Promise<void> {
    splitModelId(fromModel);
    splitModelId(toModel);
    if (fromModel === toModel) {
      throw new Error(`fallback de "${fromModel}" para ele mesmo nao leva a lugar nenhum`);
    }

    const current = await this.getFallbacks(machineId);
    const known = current.some((f) => f.fromModel === fromModel && f.toModel === toModel);

    // Aresta que ja existia nao tem como fechar ciclo novo, so muda de ordem.
    if (!known && reaches(current, toModel, fromModel)) {
      throw new Error(
        `fallback de "${fromModel}" para "${toModel}" fecha um ciclo na tabela de "${machineId}"`,
      );
    }

    await this.db
      .delete(schema.modelFallbacks)
      .where(
        and(
          eq(schema.modelFallbacks.machineId, machineId),
          eq(schema.modelFallbacks.fromModel, fromModel),
          eq(schema.modelFallbacks.toModel, toModel),
        ),
      );

    await this.db
      .insert(schema.modelFallbacks)
      .values({ id: randomUUID(), machineId, fromModel, toModel, order });
  }

  /** Onde o passo cairia nesta maquina, sem precisar disparar um run. */
  async resolvePreview(model: string, machineId: string): Promise<ModelPreview> {
    const fallbacks = await this.getFallbacks(machineId);
    try {
      return { ok: true, resolution: resolveModel(model, fallbacks, this.providers) };
    } catch (err) {
      return { ok: false, requested: model, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Existe caminho de `from` ate `target` seguindo as substituicoes ja gravadas. */
function reaches(edges: FallbackRow[], from: string, target: string): boolean {
  const seen = new Set<string>();
  const queue = [from];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) {
      if (edge.fromModel === current) queue.push(edge.toModel);
    }
  }
  return false;
}

export const providerService = new ProviderService();
