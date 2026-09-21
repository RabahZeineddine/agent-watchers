import type { ActionHandler } from "../approval/gate.js";
import { buildDigestProposal, DigestProposal } from "./proposal.js";

/**
 * O handler da ação `digest.deliver`.
 *
 * Ele é o primeiro que passa pela fila sem ter lado de fora. Um digest não
 * publica nada: o que ele propõe é leitura, e o clique na fila quer dizer "li",
 * não "manda". Por isso `publish` não chama ninguém, e não é esquecimento.
 *
 * Mesmo sem saída, o caminho continua sendo a gate. É ela que grava a proposta
 * antes de qualquer decisão, que mostra a pendência na inbox e que registra
 * quando ela foi resolvida, e um digest que aparecesse por fora disso seria uma
 * segunda inbox com regra própria.
 *
 * `modes` recusa `auto` e `draft`, e a trava é de código: um digest entregue
 * sozinho sairia da fila sem ninguém ter lido, que é o contrário do que ele
 * existe para fazer, e rascunho de leitura não quer dizer nada.
 *
 * Entregar não acontece aqui. O cursor da entrega anda quando o evento do
 * digest é gravado, em `ingest.ts`, porque uma pendência parada dias na fila
 * seguraria toda a conversa seguinte fora do próximo digest.
 */
export function digestDeliverHandler(): ActionHandler {
  return {
    modes: ["approve"],

    async propose(payload) {
      return buildDigestProposal(payload);
    },

    async publish(payload) {
      // Parse por disciplina, e não por necessidade: nada sai daqui, mas uma
      // pendência editada na inbox continua tendo que ser um digest inteiro
      // para poder ser dada por lida.
      DigestProposal.parse(payload);
    },
  };
}
