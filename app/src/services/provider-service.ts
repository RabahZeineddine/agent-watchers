import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import {
  buildProviders,
  resolveModel,
  splitModelId,
  PROVIDER_SECRET_VARS,
  type FallbackRow,
  type ModelResolution,
  type ProviderEntry,
} from "../providers/registry.js";
import { secretService, type SecretService } from "./secret-service.js";

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
    private providers: Record<string, ProviderEntry> = buildProviders(),
    private readonly secrets: SecretService = secretService,
  ) {}

  /**
   * Remonta os provedores com o que estiver guardado no keychain.
   *
   * Nao acontece na construcao porque o cofre so abre dentro do app Electron, e
   * o servico e importado tambem pela linha de comando e pelo servidor MCP.
   * Quem monta o executor chama isto antes, e quem nao chamar continua vendo o
   * ambiente do processo, que e o comportamento de sempre.
   */
  async loadSecrets(): Promise<string[]> {
    const rows = await this.db.select().from(schema.providers);
    const secrets: Record<string, string> = {};
    const carregados: string[] = [];

    for (const row of rows) {
      if (!row.enabled || !row.credentialRef) continue;
      const variavel = PROVIDER_SECRET_VARS[row.kind];
      if (!variavel) continue;

      const secret = this.secrets.get(row.credentialRef);
      if (secret === undefined) continue;
      secrets[variavel] = secret;
      carregados.push(row.id);
    }

    this.providers = buildProviders(secrets);
    return carregados;
  }

  /** Os provedores como estao agora, para quem precisa montar um runtime. */
  entries(): Record<string, ProviderEntry> {
    return this.providers;
  }

  /**
   * Aponta o provider para uma credencial do cofre, criando a linha se ela
   * ainda nao existir. `null` desfaz o vinculo e devolve o provider ao
   * ambiente. O segredo em si nao passa por aqui: isto grava so o endereco.
   */
  async setCredentialRef(name: string, ref: string | null): Promise<void> {
    if (!(name in this.providers)) throw new Error(`provider "${name}" nao existe`);
    if (ref !== null && !(name in PROVIDER_SECRET_VARS)) {
      throw new Error(`provider "${name}" nao usa chave de API, nao ha o que guardar`);
    }
    if (ref !== null) this.secrets.pathFor(ref);

    await this.db
      .insert(schema.providers)
      .values({ id: name, kind: name, credentialRef: ref })
      .onConflictDoUpdate({ target: schema.providers.id, set: { credentialRef: ref } });
  }

  /** Para quem administra: qual credencial cada provider aponta. */
  async credentialRefs(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(schema.providers);
    return Object.fromEntries(
      rows.filter((r) => r.credentialRef).map((r) => [r.id, r.credentialRef!]),
    );
  }

  listProviders(): ProviderInfo[] {
    return Object.entries(this.providers).map(([name, entry]) => ({
      name,
      available: entry.available(),
      subscription: entry.model === undefined,
      requires: entry.requires,
    }));
  }

  /**
   * Modelos que o provedor declara ter, perguntando a ele.
   *
   * Nao existe lista fixa no codigo de proposito. Um gateway expoe o catalogo
   * que a organizacao dele decidiu, e um id chutado aqui quebra na primeira
   * chamada, tarde, dentro de uma execucao.
   */
  async listModels(name: string): Promise<{ modelos: string[]; erro?: string }> {
    const entry = this.providers[name];
    if (!entry) return { modelos: [], erro: `provedor "${name}" nao existe` };
    if (!entry.available()) {
      return { modelos: [], erro: `provedor "${name}" sem credencial nesta maquina` };
    }
    if (!entry.catalog) {
      return { modelos: [], erro: `provedor "${name}" nao publica catalogo de modelos` };
    }

    const { url, headers } = entry.catalog();
    try {
      const resposta = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!resposta.ok) {
        return { modelos: [], erro: `catalogo respondeu ${resposta.status}` };
      }
      const corpo = (await resposta.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
      // OpenAI e compativeis devolvem `data[].id`; Anthropic tambem. Ollama, na
      // rota nativa, devolve `models[].name`, e a compativel devolve `data`.
      const ids = (corpo.data ?? []).map((m) => m.id).concat((corpo.models ?? []).map((m) => m.name));
      return { modelos: ids.filter((v): v is string => typeof v === "string").sort() };
    } catch (err) {
      return { modelos: [], erro: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Catalogo de todos os provedores disponiveis, prefixado com o nome deles. */
  async listAllModels(): Promise<{ provedor: string; modelos: string[]; erro?: string }[]> {
    const disponiveis = this.listProviders().filter((p) => p.available && !p.subscription);
    return Promise.all(
      disponiveis.map(async (p) => ({ provedor: p.name, ...(await this.listModels(p.name)) })),
    );
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
    const [preview] = await this.resolvePreviews([model], machineId);
    return preview!;
  }

  /**
   * A mesma previa para varios modelos, com uma leitura so da tabela.
   *
   * Quem pergunta por um passo costuma perguntar pelo spec inteiro, e chamar
   * `resolvePreview` em laco releria os fallbacks da maquina a cada passo: sao
   * N consultas para responder uma pergunta que muda com uma tabela so.
   */
  async resolvePreviews(models: string[], machineId: string): Promise<ModelPreview[]> {
    const fallbacks = await this.getFallbacks(machineId);
    return models.map((model) => {
      try {
        return { ok: true, resolution: resolveModel(model, fallbacks, this.providers) };
      } catch (err) {
        return {
          ok: false,
          requested: model,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
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
