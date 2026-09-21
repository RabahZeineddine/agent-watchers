import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { McpRegistry } from "../mcp/registry.js";
import { mcpService, type McpService } from "../services/mcp-service.js";

type Db = typeof defaultDb;

/**
 * Marca que a varredura troca pelo cursor antes de chamar a ferramenta.
 *
 * O argumento é cadastrado como qualquer outro, e não como campo próprio do
 * gatilho, porque cada servidor chama a janela pelo nome que quer: `since`,
 * `oldest`, `updated_after`. Um campo fixo obrigaria a traduzir esses nomes
 * aqui dentro, e o próximo servidor que aparecesse com outro nome exigiria
 * mudança no esquema em vez de mudança no cadastro.
 */
export const CURSOR_TOKEN = "{{cursor}}";

/**
 * Cursor de uma fonte que nunca varreu.
 *
 * O epoch, e não um retrovisor de algumas horas como no GitHub. Quem sabe
 * quanta história existe do outro lado é a ferramenta, não o Locum: uma janela
 * inventada aqui perderia em silêncio tudo que for mais antigo que ela na
 * primeira varredura de uma fonte recém cadastrada, que é justamente a
 * varredura em que a pessoa quer ver o que já estava lá.
 */
const CURSOR_INICIAL = new Date(0).toISOString();

/** Quem chama a ferramenta. Entra como dependência para poder ser trocado. */
export type McpCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface McpPollInput {
  /** Servidor MCP cadastrado e habilitado. */
  server: string;
  tool: string;
  /** Argumentos do cadastro, ainda com `{{cursor}}` por trocar. */
  args: Record<string, unknown>;
}

export interface McpPollOptions {
  db?: Db;
  mcp?: McpService;
  call?: McpCaller;
  /** Relógio da varredura. Existe para teste e para reproduzir uma batida antiga. */
  now?: () => number;
}

export interface McpPollOutcome {
  /** Eventos que esta varredura gravou. Item já conhecido não entra. */
  eventIds: string[];
  /** Itens que a consulta trouxe, incluindo os que já eram conhecidos. */
  seen: number;
  /** Cursor depois desta varredura. */
  cursor: string;
}

/**
 * A terceira forma de fonte prevista no ADR 0001: perguntar a um servidor MCP.
 *
 * Existe para ambiente onde não dá para registrar aplicativo, que é o caso de
 * Slack e Teams corporativos: não há webhook para receber nem SDK para chamar,
 * mas há um servidor MCP que alguém já autorizou. O contrato de saída é o mesmo
 * das outras duas, evento normalizado na tabela `events`, para que o resto do
 * aplicativo não saiba de onde o trabalho veio.
 *
 * Varre por cursor de tempo e deduplica por chave externa, como a varredura do
 * GitHub, e pelo mesmo motivo: intervalo fixo morre quando o Mac dorme, e sem
 * a chave externa a mesma mensagem viraria execução de novo a cada batida.
 */
export async function pollMcpServer(
  input: McpPollInput,
  options: McpPollOptions = {},
): Promise<McpPollOutcome> {
  const db = options.db ?? defaultDb;
  const call = options.call ?? throughRegistry(options.mcp ?? mcpService);
  const source = sourceName(input.server);
  const key = cursorKey(input);

  const [row] = await db
    .select({ value: schema.cursors.value })
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, key)));
  const cursor = row?.value ?? CURSOR_INICIAL;

  // Lido antes da chamada, e não depois: item que nascer enquanto a ferramenta
  // responde precisa cair na próxima varredura. Só serve de marca d'água para
  // a fonte que não carimba item, e a sobreposição que ele causa é inofensiva
  // porque a chave externa mata o repetido.
  const antesDaChamada = new Date(options.now?.() ?? Date.now()).toISOString();

  const items = itemsOf(unwrap(await call(input.server, input.tool, render(input.args, cursor))));

  const eventIds: string[] = [];
  let carimbado = false;
  let newest = cursor;

  for (const item of items) {
    const at = stampOf(item);
    const id = randomUUID();
    const inserted = await db
      .insert(schema.events)
      .values({
        id,
        source,
        externalId: externalId(input.tool, item),
        payload: {
          // O executor lê `repo` e `changedFiles` de todo evento. Aqui não há
          // repositório nenhum, e o par servidor e ferramenta é o que responde
          // "de onde veio isto" na lista de execuções.
          repo: `${input.server}/${input.tool}`,
          changedFiles: [],
          server: input.server,
          tool: input.tool,
          at: at ?? null,
          item,
        },
      })
      .onConflictDoNothing()
      .returning({ id: schema.events.id });

    if (inserted.length > 0) eventIds.push(id);
    if (at !== undefined) {
      carimbado = true;
      if (at > newest) newest = at;
    }
  }

  // Depois de gravar, nunca antes: um crash no meio do laço deixaria o cursor
  // à frente dos itens que ainda não viraram evento, e eles não voltariam.
  //
  // A marca d'água só entra quando nenhum item veio carimbado. Usá-la também
  // quando vieram pularia a janela entre o carimbo mais novo e agora.
  const next = carimbado ? newest : antesDaChamada;
  await db
    .insert(schema.cursors)
    .values({ source, key, value: next })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value: next, updatedAt: Math.floor(Date.now() / 1000) },
    });

  return { eventIds, seen: items.length, cursor: next };
}

/** Fonte gravada no evento e no cursor. Um servidor, uma fonte. */
export function sourceName(server: string): string {
  return `mcp:${server}`;
}

/**
 * Chave do cursor.
 *
 * A ferramenta sozinha não basta: dois gatilhos podem perguntar o mesmo `feed`
 * do mesmo servidor com filtros diferentes, e um cursor só faria o segundo
 * herdar a janela que o primeiro já consumiu. O resumo dos argumentos separa os
 * dois sem obrigar o cadastro a inventar um nome.
 */
export function cursorKey(input: Pick<McpPollInput, "tool" | "args">): string {
  return `${input.tool}:${digest(input.args)}`;
}

/**
 * Troca `{{cursor}}` em qualquer texto do argumento, em qualquer profundidade.
 *
 * Por pedaço e não por igualdade, porque servidor que espera `"oldest:<ts>"`
 * ou um filtro montado em texto é comum, e exigir que o valor seja só a marca
 * deixaria esses de fora.
 */
export function render(value: Record<string, unknown>, cursor: string): Record<string, unknown> {
  return replace(value, cursor) as Record<string, unknown>;
}

function replace(value: unknown, cursor: string): unknown {
  if (typeof value === "string") return value.split(CURSOR_TOKEN).join(cursor);
  if (Array.isArray(value)) return value.map((v) => replace(v, cursor));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replace(v, cursor)]),
    );
  }
  return value;
}

/**
 * Tira o resultado de dentro do envelope do MCP.
 *
 * `isError` vira exceção de propósito. O protocolo devolve a falha como
 * resposta bem sucedida, e quem não olhasse esse campo trataria a mensagem de
 * erro como conteúdo: viraria evento e, pior, faria o cursor andar por cima de
 * uma janela que ninguém chegou a ler.
 */
export function unwrap(result: unknown): unknown {
  const envelope = result as { content?: unknown; isError?: unknown } | null | undefined;
  if (envelope === null || envelope === undefined || !Array.isArray(envelope.content)) {
    return result;
  }

  const texto = envelope.content
    .filter((bloco): bloco is { type: "text"; text: string } => {
      const b = bloco as { type?: unknown; text?: unknown };
      return b?.type === "text" && typeof b.text === "string";
    })
    .map((bloco) => bloco.text)
    .join("");

  if (envelope.isError === true) throw new Error(texto || "a ferramenta MCP respondeu com erro");

  try {
    return JSON.parse(texto);
  } catch {
    // Ferramenta que responde prosa continua servindo de fonte: vira um item só.
    return texto;
  }
}

/**
 * Os itens de uma resposta.
 *
 * O contrato é curto de propósito: lista no topo, ou lista em `items`. Tudo
 * mais é um item só. Sair adivinhando nome de campo faria a fonte inventar
 * lista onde o servidor devolveu um objeto, e cada item inventado vira uma
 * execução que ninguém pediu.
 */
export function itemsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const lista = (payload as { items?: unknown } | null | undefined)?.items;
  if (Array.isArray(lista)) return lista;
  return [payload];
}

/**
 * Chave de deduplicação do item.
 *
 * O `id` do próprio item quando ele tem um, porque é o que sobrevive a uma
 * edição: mensagem que ganhou uma correção continua sendo a mesma mensagem. Sem
 * `id`, o resumo do conteúdo, que é o melhor que dá para fazer e o que a
 * varredura por MCP já fazia antes de existir esta fonte.
 */
export function externalId(tool: string, item: unknown): string {
  const bruto = (item as { id?: unknown } | null | undefined)?.id;
  const id = typeof bruto === "string" || typeof bruto === "number" ? String(bruto) : undefined;
  return `${tool}:${id ?? digest(item)}`;
}

/** Carimbo do item, quando ele tem um que dá para ordenar. */
function stampOf(item: unknown): string | undefined {
  const at = (item as { at?: unknown } | null | undefined)?.at;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  return at;
}

/**
 * Sobe o servidor cadastrado só para esta chamada e o devolve encerrado.
 *
 * Nada fica de pé entre varreduras: o processo stdio pesa dezenas de megabytes,
 * e um gatilho de quinze em quinze minutos não justifica segurá-lo.
 */
function throughRegistry(mcp: McpService): McpCaller {
  return async (server, tool, args) => {
    const registry = McpRegistry.fromList(await mcp.enabledConfigs());
    if (!registry.has(server)) throw new Error(`servidor MCP "${server}" nao esta habilitado`);
    try {
      return await registry.callTool(server, tool, args);
    } finally {
      await registry.closeAll();
    }
  };
}

/** Resumo estável. O corpo inteiro não serve de chave porque não tem tamanho máximo. */
function digest(value: unknown): string {
  return createHash("sha1")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex")
    .slice(0, 16);
}
