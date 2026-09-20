import type { AgentSpec } from "../config/types.js";
import { prReviewSpec } from "../seed/pr-review.js";
import { agentService, type AgentVersion } from "../services/agent-service.js";

/**
 * Historico plantado do agent semente, para a tela de agents ter o que comparar.
 *
 * A comparacao entre duas versoes so prova alguma coisa quando existem duas, e
 * um banco novo tem uma. Rodar o agent de verdade para ganhar a segunda custaria
 * minutos de assinatura a cada iteracao do loop, pelo mesmo motivo que
 * `demo-run.ts` planta uma execucao em vez de rodar o pipeline.
 *
 * A versao plantada e a antiga, nao a nova: ela grava o passo de acao em
 * `draft` e logo em seguida o spec canonico volta por cima, entao o topo do
 * historico continua sendo `approve`. A ordem importa. Deixar `draft` no topo
 * faria o fixture afrouxar o modo de publicacao do agent que roda nesta
 * maquina, e o teto do que sai sem clique nao e coisa que verificacao mexe.
 */

const NOTA_ANTIGA = "fixture: rascunho antes da trava de aprovacao";
const NOTA_ATUAL = "agent semente";

/** O spec de antes: o mesmo, com o passo de acao em modo de rascunho. */
function specAntigo(): AgentSpec {
  return {
    ...prReviewSpec,
    steps: prReviewSpec.steps.map((passo) =>
      passo.type === "action" && passo.key === "post"
        ? { ...passo, mode: "draft" as const }
        : passo,
    ),
  };
}

/** Modo do passo de acao de uma versao, ou nulo se ela nao tiver nenhum. */
function modoDaAcao(versao: AgentVersion): string | null {
  const acao = versao.spec.steps.find((passo) => passo.type === "action");
  return acao === undefined ? null : acao.mode;
}

/**
 * Garante que o agent semente tem historico com uma diferenca visivel.
 *
 * Idempotente pelo conteudo, e nao por identificador: `upsert` devolve a versao
 * existente quando o spec bate com o topo, entao a checagem antes da gravacao e
 * o que impede o historico de crescer duas linhas a cada subida do smoke.
 */
export async function ensureAgentHistory(): Promise<AgentVersion[]> {
  const agentId = prReviewSpec.id;
  const antes = await agentService.listVersions(agentId);
  const topo = antes[0];

  const jaServe =
    antes.length >= 2 &&
    topo !== undefined &&
    modoDaAcao(topo) === "approve" &&
    antes.some((versao) => modoDaAcao(versao) !== "approve");

  if (!jaServe) {
    // `human` porque `agent` rebaixaria o `draft` para `approve` na gravacao, e
    // as duas versoes sairiam identicas: nao haveria diferenca para comparar.
    await agentService.upsert(specAntigo(), NOTA_ANTIGA, "human");
    await agentService.upsert(prReviewSpec, NOTA_ATUAL, "human");
  }

  return agentService.listVersions(agentId);
}
