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
import { secretService, type SecretService } from "./secret-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

type Db = typeof defaultDb;

/**
 * Onde a chave de um provedor mora no cofre.
 *
 * Endereço por convenção, e não cadastrado: o provedor já é identificado pelo
 * nome no registro, e pedir a alguém que invente um endereço para gravar uma
 * chave seria cerimônia sem escolha real por trás. Quem já tinha apontado o
 * `credential_ref` para outro lugar continua valendo, porque a leitura segue o
 * cadastro e só cai nesta convenção quando não há linha.
 */
export function providerCredentialRef(name: string): string {
  return `provider/${name}`;
}

/** O que a última conferência de catálogo descobriu, guardado por referência. */
const CONFERIDO_EM = "checkedAt";
const MODELOS = "models";

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
 * A chave de um provedor como ela pode ser mostrada: onde mora, se existe, e o
 * que a ultima conferencia descobriu. Nunca o valor.
 */
export interface ProviderCredential {
  provider: string;
  /** Variavel que a chave preenche. Nulo quando o provedor nao guarda chave. */
  variable: string | null;
  /** Endereco no cofre, nulo junto com `variable`. */
  ref: string | null;
  /** Existe texto cifrado guardado. Vale mesmo sem keychain neste processo. */
  stored: boolean;
  /** Este processo alcanca o keychain, isto e, da para gravar valor. */
  vault: boolean;
  /** A variavel existe no ambiente deste processo, que e o caminho de tras. */
  env: boolean;
  /** Segundos desde a epoca, ou nulo quando nunca foi conferida. */
  checkedAt: number | null;
  /** Quantos modelos o catalogo devolveu na ultima conferencia. */
  modelCount: number | null;
}

/**
 * O desfecho de uma conferencia de catalogo.
 *
 * `missing` e a falta de credencial, e nao chega a sair da maquina: perguntar
 * o catalogo sem chave gastaria uma viagem para ouvir o que ja se sabe daqui.
 */
export type ProviderCheck =
  | { ok: true; count: number; checkedAt: number }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "refused"; message: string };

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
    private readonly settings: SettingsService = settingsService,
    /**
     * Como remontar o registro quando o cofre muda.
     *
     * Entra pelo construtor porque `buildProviders` é função de módulo: sem
     * isto, quem construir o serviço com provedores próprios os perderia na
     * primeira gravação de chave, que é justamente o que o smoke faz.
     */
    private readonly build: (
      secrets: Record<string, string>,
    ) => Record<string, ProviderEntry> = buildProviders,
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
      const variavel = this.providers[row.id]?.secretVar;
      if (!variavel) continue;

      const secret = this.secrets.get(row.credentialRef);
      if (secret === undefined) continue;
      secrets[variavel] = secret;
      carregados.push(row.id);
    }

    this.providers = this.build(secrets);
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
    if (ref !== null && this.providers[name]?.secretVar === undefined) {
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

  /**
   * A referência que vale para um provedor: a cadastrada, ou a convenção.
   *
   * A ordem importa. Quem já apontou o `credential_ref` para outro endereço
   * pela linha de comando continua sendo lido de lá, e só quem nunca apontou
   * cai em `provider/<nome>`, que é onde a tela vai gravar.
   */
  private async refDe(name: string): Promise<string> {
    const cadastradas = await this.credentialRefs();
    return cadastradas[name] ?? providerCredentialRef(name);
  }

  private chave(ref: string, sufixo: string): string {
    return `provider:${ref}:${sufixo}`;
  }

  /**
   * O que a tela pode saber sobre a chave de cada provedor.
   *
   * O valor não cabe neste tipo, pela mesma razão do `CredentialRef` e do
   * `GithubStatus`: daqui sai o endereço, o sim ou não, e o que a última
   * conferência respondeu. O segredo só sai pelo caminho de quem vai conectar,
   * que é o `loadSecrets` alimentando o registro.
   */
  async credentials(): Promise<ProviderCredential[]> {
    const cadastradas = await this.credentialRefs();

    return Promise.all(
      Object.entries(this.providers).map(async ([provider, entry]) => {
        const variable = entry.secretVar ?? null;
        const ref =
          variable === null ? null : (cadastradas[provider] ?? providerCredentialRef(provider));

        const [conferidoEm, modelos] =
          ref === null
            ? [undefined, undefined]
            : await Promise.all([
                this.settings.get(this.chave(ref, CONFERIDO_EM)),
                this.settings.get(this.chave(ref, MODELOS)),
              ]);

        const doAmbiente = variable === null ? undefined : process.env[variable];

        return {
          provider,
          variable,
          ref,
          stored: ref !== null && this.secrets.has(ref),
          vault: this.secrets.available,
          env: doAmbiente !== undefined && doAmbiente.length > 0,
          checkedAt: conferidoEm === undefined ? null : Number(conferidoEm),
          modelCount: modelos === undefined ? null : Number(modelos),
        };
      }),
    );
  }

  /**
   * Guarda a chave do provedor e o deixa disponível na hora.
   *
   * O `loadSecrets` no fim é o que a story pede por "sem reabrir a janela": o
   * registro é reconstruído com a chave nova, e a próxima leitura de
   * `listProviders` já responde disponível. Sem ele a chave estaria guardada e
   * o provedor continuaria apagado até o próximo executor ser montado.
   *
   * A conferência anterior é jogada fora junto, pela mesma razão do token do
   * GitHub: a contagem de modelos descreve a chave que estava ali, e mantê-la
   * depois da troca faria a tela afirmar, com cara de dado conferido, um
   * catálogo que a chave nova pode nem alcançar.
   */
  async setSecret(name: string, secret: string): Promise<void> {
    const entry = this.providers[name];
    if (!entry) throw new Error(`provider "${name}" nao existe`);
    if (entry.secretVar === undefined) {
      throw new Error(`provider "${name}" nao usa chave de API, nao ha o que guardar`);
    }

    const limpo = secret.trim();
    if (limpo.length === 0) throw new Error("chave vazia nao se guarda, use clearSecret");

    const ref = await this.refDe(name);
    this.secrets.set(ref, limpo);
    await this.setCredentialRef(name, ref);
    await this.esquecerConferencia(ref);
    await this.loadSecrets();
  }

  /** Devolve se havia algo para apagar. */
  async clearSecret(name: string): Promise<boolean> {
    if (!(name in this.providers)) throw new Error(`provider "${name}" nao existe`);

    const ref = await this.refDe(name);
    const havia = this.secrets.remove(ref);
    await this.setCredentialRef(name, null);
    await this.esquecerConferencia(ref);
    await this.loadSecrets();
    return havia;
  }

  /**
   * Pergunta ao provedor quantos modelos ele tem, e guarda a resposta.
   *
   * É o exame que diz se a chave presta, e ele não inventa critério próprio:
   * quem responde é o catálogo do provedor, que é a mesma porta que o resto do
   * app usa para montar a lista de modelos. Sem credencial nenhuma a resposta
   * sai de dentro da máquina, sem gastar uma viagem para descobrir o que já se
   * sabe daqui.
   *
   * A mensagem de recusa passa adiante como veio. O `listModels` só a monta a
   * partir do código de status ou da falha de rede, e a chave viaja em
   * cabeçalho, nunca na URL: não há por onde ela entrar no texto.
   */
  async check(name: string): Promise<ProviderCheck> {
    const entry = this.providers[name];
    if (!entry) return { ok: false, reason: "refused", message: `provedor "${name}" nao existe` };
    if (!entry.available()) return { ok: false, reason: "missing" };

    const { modelos, erro } = await this.listModels(name);
    if (erro !== undefined) return { ok: false, reason: "refused", message: erro };

    const ref = await this.refDe(name);
    const checkedAt = Math.floor(Date.now() / 1000);
    await this.settings.set(this.chave(ref, MODELOS), String(modelos.length));
    await this.settings.set(this.chave(ref, CONFERIDO_EM), String(checkedAt));

    return { ok: true, count: modelos.length, checkedAt };
  }

  private async esquecerConferencia(ref: string): Promise<void> {
    await this.settings.remove(this.chave(ref, MODELOS));
    await this.settings.remove(this.chave(ref, CONFERIDO_EM));
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
