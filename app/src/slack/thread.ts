import { desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { slackSource } from "../sources/slack.js";

type Db = typeof defaultDb;

/**
 * Quantos eventos do canal a busca lê antes de desistir.
 *
 * Mesmo teto e mesma razão da ingestão do digest: a tabela de eventos só
 * cresce, e procurar uma thread de ontem não justifica ler um ano de conversa.
 * Thread velha demais para estar aqui é thread que ninguém está respondendo.
 */
const TETO_DE_LEITURA = 500;

/** O que se sabe de uma thread já lida, e o que a fila mostra sobre ela. */
export interface SlackThread {
  channel: string;
  threadTs: string;
  /** O texto da mensagem que abriu a thread, quando ela foi lida. */
  subject: string;
  permalink: string | null;
}

export interface SlackThreadOptions {
  db?: Db;
}

/**
 * Acha, no que o Locum já leu, a thread a que uma resposta aponta.
 *
 * É a trava que faz a thread continuar vindo do evento mesmo tendo passado
 * pelo modelo. O carimbo só serve se existir mensagem lida com ele no canal, e
 * um carimbo inventado não acha nada: o passo falha antes de virar pendência,
 * em vez de propor uma resposta para uma conversa que ninguém teve.
 *
 * Serve tanto a abertura quanto a resposta: quem responde a uma thread cuja
 * abertura ficou fora da janela lida continua achando a thread pelas respostas
 * dela, e aí o assunto sai da mensagem mais antiga que veio.
 */
export async function findThread(
  server: string,
  channel: string,
  threadTs: string,
  options: SlackThreadOptions = {},
): Promise<SlackThread | null> {
  const db = options.db ?? defaultDb;

  // As mais recentes primeiro, e o casamento vem depois, em memória. Filtrar
  // por canal no SQL exigiria abrir o JSON do evento a cada linha, e o teto de
  // leitura já limita o que se paga por isso.
  const linhas = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.source, slackSource(server)))
    .orderBy(desc(schema.events.receivedAt))
    .limit(TETO_DE_LEITURA);

  let achada: SlackThread | null = null;
  for (const linha of linhas) {
    const corpo = linha.payload as Record<string, unknown>;
    if (texto(corpo.channel) !== channel) continue;

    const ts = texto(corpo.ts);
    if (ts === null) continue;
    const thread = texto(corpo.threadTs) ?? ts;
    if (thread !== threadTs) continue;

    achada = {
      channel,
      threadTs,
      subject: String(corpo.text ?? ""),
      permalink: texto(corpo.permalink),
    };

    // Quem abriu a thread dá o assunto. As linhas vêm da mais nova para a mais
    // velha, então a abertura encerra a busca e qualquer outra só vale
    // enquanto ela não aparecer.
    if (ts === threadTs) break;
  }

  return achada;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}
