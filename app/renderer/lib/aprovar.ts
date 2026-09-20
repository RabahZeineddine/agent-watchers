import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";

/**
 * Acesso estreito a decisao de aprovacao.
 *
 * Isto fica fora de `lib/bridge.ts` de proposito. Aquele arquivo e o catalogo
 * que qualquer coisa rodando na janela enxerga, inclusive o assistente do chat,
 * e a emenda 5 do ADR 0003 existe porque `approvals.decide` dentro de um
 * catalogo e uma instrucao plantada num diff virando publicacao.
 *
 * Aprovar nao e uma acao da janela: e o clique de uma pessoa. Quem chama daqui
 * e o botao, e mais ninguem.
 */
type Decisao = "approved" | "rejected";

interface PonteDeDecisao {
  approvals: { decide: (id: string, decisao: Decisao) => Promise<unknown> };
}

export async function decidir(approvalId: string, decisao: Decisao): Promise<void> {
  const ponte = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDeDecisao | undefined;
  if (!ponte?.approvals?.decide) throw new Error("ponte indisponivel");
  await ponte.approvals.decide(approvalId, decisao);
}
