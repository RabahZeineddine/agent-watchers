import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { newer } from "../sources/mcp-poll.js";
import { slackSource } from "../sources/slack.js";

type Db = typeof defaultDb;

/** Fonte do evento de digest e do cursor de entrega. */
export const DIGEST_SOURCE = "digest";

/** Chave do cursor de entrega. Um servidor de Slack, uma entrega. */
export function digestCursorKey(server: string): string {
  return slackSource(server);
}

/** Cursor de quem nunca recebeu digest nenhum, no formato de carimbo do Slack. */
const CURSOR_INICIAL = "0";

/**
 * Quantas mensagens a ingestão lê do banco por digest.
 *
 * Teto de leitura, e não janela: quem limita o que entra é o cursor da última
 * entrega. Existe porque a tabela de eventos só cresce, e um banco de um ano
 * seria lido inteiro a cada batida para montar um resumo de ontem.
 */
const TETO_DE_LEITURA = 500;

/** Threads por canal, e mensagens por thread, que chegam ao modelo. */
const TETO_POR_CANAL = 10;
const TETO_POR_THREAD = 6;

/** Onde cada mensagem é cortada. O modelo resume; ele não precisa do anexo. */
const TETO_DE_TEXTO = 280;

/** Onde o assunto da thread é cortado, para caber numa linha de digest. */
const TETO_DE_ASSUNTO = 80;

/**
 * Marcadores de canal que o Slack manda como mensagem e ninguém lê.
 *
 * Entrar e sair de canal, mudar tópico ou nome, fixar item: é ruído que o
 * cursor não filtra, porque para a fonte cada um deles é uma mensagem nova.
 * Deixá-los passar faria o modelo gastar contexto para concluir que alguém
 * entrou no canal.
 */
const RUIDO = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
]);

/** Uma mensagem do agrupamento, já cortada no tamanho que vai ao modelo. */
export interface DigestMessage {
  author: string | null;
  text: string;
  ts: string;
  reply: boolean;
}

/** Uma thread, que é o assunto dentro do canal. */
export interface DigestThread {
  threadTs: string;
  /** A primeira linha da thread, cortada. É por ela que o digest é lido. */
  subject: string;
  permalink: string | null;
  messages: DigestMessage[];
  /** Mensagens da thread que ficaram fora do teto. */
  more: number;
}

export interface DigestChannel {
  channel: string;
  threads: DigestThread[];
  /** Threads do canal que ficaram fora do teto. */
  more: number;
}

export interface DigestBundle {
  server: string;
  /** A entrega anterior, ou o cursor inicial na primeira vez. */
  since: string;
  /** O carimbo da mensagem mais nova que entrou. Vira o cursor da entrega. */
  until: string;
  channels: DigestChannel[];
  /** Mensagens que sobraram depois do filtro e dos tetos. */
  messages: number;
  /** Mensagens descartadas por serem ruído ou por não terem texto. */
  dropped: number;
}

export interface DigestOptions {
  db?: Db;
}

/**
 * Junta o que chegou desde a última entrega, agrupa por canal e por thread, e
 * corta o que não vale a pena mandar para o modelo.
 *
 * Tudo aqui é determinístico, e é de propósito. Agrupar e filtrar é trabalho de
 * comparação de carimbo e de campo vazio, e pagar um modelo para fazer isso
 * seria mandar o canal inteiro para ele antes de saber se há alguma coisa para
 * resumir. O modelo entra depois, em cima do que sobrou, para dizer o que pede
 * resposta, o que é informação e o que dá para ignorar.
 *
 * Nada é publicado, e nada é apagado: a ingestão só lê os eventos que a fonte
 * do Slack já gravou.
 */
export async function collectSlackDigest(
  server: string,
  options: DigestOptions = {},
): Promise<DigestBundle> {
  const db = options.db ?? defaultDb;
  const source = slackSource(server);

  const [cursor] = await db
    .select({ value: schema.cursors.value })
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, DIGEST_SOURCE), eq(schema.cursors.key, digestCursorKey(server))));
  const since = cursor?.value ?? CURSOR_INICIAL;

  // As mais recentes primeiro, e o corte pelo carimbo vem depois, em memória.
  // Filtrar por `ts` no SQL exigiria abrir o JSON do evento a cada linha, e o
  // que se ganharia é o mesmo que o teto de leitura já garante.
  const linhas = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.source, source))
    .orderBy(desc(schema.events.receivedAt))
    .limit(TETO_DE_LEITURA);

  let until = since;
  let dropped = 0;
  const porCanal = new Map<string, Map<string, DigestMessage[]>>();
  const abertura = new Map<string, { subject: string; permalink: string | null }>();

  for (const linha of [...linhas].reverse()) {
    const corpo = linha.payload as Record<string, unknown>;
    const ts = texto(corpo.ts);
    const channel = texto(corpo.channel);
    if (ts === null || channel === null) continue;
    // Já entregue: o cursor é inclusive do lado de baixo, como o `oldest` do
    // Slack, então a última mensagem da entrega anterior volta a aparecer.
    if (newer(since, ts) === since) continue;

    until = newer(until, ts);

    if (descartar(corpo)) {
      dropped += 1;
      continue;
    }

    const threadTs = texto(corpo.threadTs) ?? ts;
    const canal = porCanal.get(channel) ?? new Map<string, DigestMessage[]>();
    porCanal.set(channel, canal);
    const thread = canal.get(threadTs) ?? [];
    canal.set(threadTs, thread);
    thread.push({
      author: texto(corpo.author),
      text: cortar(String(corpo.text ?? ""), TETO_DE_TEXTO),
      ts,
      reply: corpo.reply === true,
    });

    // Quem abre a thread dá o assunto e o endereço. A abertura pode ter ficado
    // numa entrega anterior, e aí o assunto sai da primeira mensagem que veio.
    if (!abertura.has(threadTs) || ts === threadTs) {
      abertura.set(threadTs, {
        subject: cortar(String(corpo.text ?? ""), TETO_DE_ASSUNTO),
        permalink: texto(corpo.permalink),
      });
    }
  }

  let messages = 0;
  const channels: DigestChannel[] = [];
  for (const [channel, threads] of [...porCanal].sort(porNome)) {
    const ordenadas = [...threads].sort(([a], [b]) => (newer(a, b) === a ? -1 : 1));
    const dentro = ordenadas.slice(0, TETO_POR_CANAL);
    channels.push({
      channel,
      more: ordenadas.length - dentro.length,
      threads: dentro.map(([threadTs, mensagens]) => {
        const cabem = mensagens.slice(0, TETO_POR_THREAD);
        messages += cabem.length;
        return {
          threadTs,
          subject: abertura.get(threadTs)?.subject ?? "",
          permalink: abertura.get(threadTs)?.permalink ?? null,
          messages: cabem,
          more: mensagens.length - cabem.length,
        };
      }),
    });
  }

  return { server, since, until, channels, messages, dropped };
}

/**
 * Grava o digest como evento e move o cursor da entrega.
 *
 * A ordem é a mesma das outras fontes, e pela mesma razão: o cursor só anda
 * depois de o que ele cobre estar durável. Se o processo morrer entre uma coisa
 * e outra, o evento existe e o run é retomado na próxima subida; se andasse
 * antes, a janela inteira sumiria sem ninguém ter lido.
 *
 * Quem entrega é esta função, e não o clique de aprovação. Aprovar um digest é
 * dizer "li", e um digest que ficasse dias na fila seguraria todo o resto da
 * conversa fora da próxima entrega.
 */
export async function buildDigestEvent(
  bundle: DigestBundle,
  options: DigestOptions = {},
): Promise<string | null> {
  const db = options.db ?? defaultDb;
  if (bundle.channels.length === 0) return null;

  const id = randomUUID();
  await db.insert(schema.events).values({
    id,
    source: DIGEST_SOURCE,
    externalId: `${digestCursorKey(bundle.server)}:${bundle.until}`,
    payload: {
      // O executor lê `repo` e `changedFiles` de todo evento. Aqui não há
      // repositório, e o servidor de Slack é o que responde "de onde veio isto"
      // na lista de execuções.
      repo: `slack/${bundle.server}`,
      changedFiles: [],
      server: bundle.server,
      since: bundle.since,
      until: bundle.until,
      channels: bundle.channels,
      messages: bundle.messages,
      dropped: bundle.dropped,
      at: bundle.until,
    },
  });

  await markDelivered(bundle.server, bundle.until, options);
  return id;
}

/**
 * Move o cursor da entrega, e só para a frente.
 *
 * Nunca para trás porque duas ingestões podem se cruzar, e voltar o cursor
 * faria a entrega seguinte repetir uma conversa que já saiu.
 */
export async function markDelivered(
  server: string,
  until: string,
  options: DigestOptions = {},
): Promise<string> {
  const db = options.db ?? defaultDb;
  const key = digestCursorKey(server);

  const [atual] = await db
    .select({ value: schema.cursors.value })
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, DIGEST_SOURCE), eq(schema.cursors.key, key)));
  const valor = atual === undefined ? until : newer(atual.value, until);

  await db
    .insert(schema.cursors)
    .values({ source: DIGEST_SOURCE, key, value: valor })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value: valor, updatedAt: Math.floor(Date.now() / 1000) },
    });

  return valor;
}

/**
 * O que não chega ao modelo.
 *
 * Mensagem sem texto e marcador de canal, e nada além disso. Filtrar por
 * palavra, por autor ou por tamanho seria o digest decidindo o que interessa
 * antes de alguém ler, e é justamente isso que o passo de modelo existe para
 * fazer com critério explícito.
 */
function descartar(corpo: Record<string, unknown>): boolean {
  if (texto(corpo.text) === null) return true;
  const item = (corpo.item ?? {}) as Record<string, unknown>;
  const subtype = texto(item.subtype);
  return subtype !== null && RUIDO.has(subtype);
}

function cortar(valor: string, teto: number): string {
  const limpo = valor.trim().replace(/\s+/g, " ");
  return limpo.length <= teto ? limpo : `${limpo.slice(0, teto - 1)}…`;
}

function porNome([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}
