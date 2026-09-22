import type { ModelMessage } from "ai";

/**
 * Teto, em caracteres serializados, do histórico mandado ao modelo.
 *
 * Contado em caractere e não em token porque o assistente troca de provedor e
 * cada um conta token do seu jeito. Uns 30 mil tokens, folgado para qualquer
 * janela de contexto e baixo o bastante para a conversa não pesar na conta.
 */
export const TETO_DO_HISTORICO = 120_000;

/** Quantas trocas do fim da conversa seguem com o resultado de ferramenta. */
export const TROCAS_INTEIRAS = 4;

export interface HistoricoCompactado {
  mensagens: ModelMessage[];
  /** Verdadeiro quando alguma troca perdeu o resultado de ferramenta ou saiu inteira. */
  resumido: boolean;
}

/**
 * Enxuga o histórico do assistente antes de reenviá-lo.
 *
 * O resultado de ferramenta é a parte grande, e pergunta antiga raramente
 * depende dele: o que o modelo concluiu na época ficou no texto da resposta.
 * Por isso a troca antiga perde chamada e resultado e guarda só o texto. Se
 * ainda passar do teto, as trocas mais antigas saem inteiras.
 *
 * Chamada e resultado saem juntos, nunca um sem o outro: provedor que recebe
 * resultado sem a chamada correspondente recusa a requisição inteira.
 */
export function compactarHistorico(
  historico: ModelMessage[],
  teto = TETO_DO_HISTORICO,
  inteiras = TROCAS_INTEIRAS,
): HistoricoCompactado {
  const trocas = separarTrocas(historico);
  let resumido = false;

  const corte = Math.max(0, trocas.length - inteiras);
  for (let i = 0; i < corte; i++) {
    const enxuta = soTexto(trocas[i]!);
    if (enxuta.length !== trocas[i]!.length || enxuta.some((m, j) => m !== trocas[i]![j])) {
      resumido = true;
    }
    trocas[i] = enxuta;
  }

  // Estourou mesmo assim: as trocas recentes também perdem o resultado, da
  // mais antiga para a mais nova. A última fica como está, porque é nela que o
  // modelo está trabalhando.
  for (let i = corte; i < trocas.length - 1 && tamanho(trocas) > teto; i++) {
    trocas[i] = soTexto(trocas[i]!);
    resumido = true;
  }

  while (trocas.length > 1 && tamanho(trocas) > teto) {
    trocas.shift();
    resumido = true;
  }

  return { mensagens: trocas.flat(), resumido };
}

/** Cada troca começa numa mensagem do usuário e vai até a próxima. */
function separarTrocas(historico: ModelMessage[]): ModelMessage[][] {
  const trocas: ModelMessage[][] = [];
  for (const mensagem of historico) {
    if (mensagem.role === "user" || trocas.length === 0) trocas.push([mensagem]);
    else trocas.at(-1)!.push(mensagem);
  }
  return trocas;
}

function soTexto(troca: ModelMessage[]): ModelMessage[] {
  const enxuta: ModelMessage[] = [];
  for (const mensagem of troca) {
    if (mensagem.role !== "assistant" || typeof mensagem.content === "string") {
      if (mensagem.role !== "tool") enxuta.push(mensagem);
      continue;
    }
    const texto = mensagem.content.filter((p) => p.type === "text");
    if (texto.length === mensagem.content.length) enxuta.push(mensagem);
    else if (texto.length > 0) enxuta.push({ ...mensagem, content: texto });
  }
  return enxuta;
}

function tamanho(trocas: ModelMessage[][]): number {
  return JSON.stringify(trocas).length;
}
