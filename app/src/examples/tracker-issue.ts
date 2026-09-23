import type { Step } from "../config/types.js";
import { ISSUE_CONTENT_SCHEMA } from "../trackers/proposal.js";

/**
 * O par de passos que transforma uma auditoria em tarefa proposta.
 *
 * São dois de propósito, e não um handler esperto. O primeiro é de modelo e
 * escreve a prosa: objetivo, o que mudou e o que testar, a partir do que a
 * auditoria achou. O segundo é de ação, monta o item e para na fila. Juntar os
 * dois faria a prosa nascer dentro do handler, que é justamente onde ela não
 * pode nascer: o que sai em nome de uma pessoa tem que ser legível por ela
 * antes de sair, e um texto montado no meio da publicação só apareceria depois.
 *
 * Sai como fragmento e não como agent inteiro porque abrir tarefa é escolha de
 * quem escreve o agent, e o `pr-review` semente não tem tracker cadastrado para
 * apontar. Quem quiser as duas coisas concatena estes passos aos dele.
 */
export function trackerIssueSteps(options: {
  /** O tracker cadastrado que recebe a tarefa. */
  tracker: string;
  /** O passo de auditoria de onde sai o que escrever. */
  needs: string;
  model?: string;
}): Step[] {
  const { tracker, needs, model = "claude-code/claude-sonnet-5" } = options;

  return [
    {
      type: "model",
      key: "issue_body",
      name: "Texto da tarefa",
      needs: [needs],
      optional: false,
      model,
      maxSteps: 4,
      requiresServers: [],
      prompt: [
        "Escreva o conteudo de uma tarefa de acompanhamento para os achados",
        "desta auditoria de pull request.",
        "",
        "Em `objective`, o que precisa ficar resolvido, em uma ou duas frases.",
        "Em `changes`, o que o pull request mexeu e por onde o problema entra.",
        "Em `testing`, como conferir que foi resolvido, em passos concretos.",
        "",
        "Nao repita o diff, nao invente arquivo que nao aparece nos achados, e",
        "nao escreva titulo: o titulo e montado a partir do pull request.",
        "",
        "Pull request: {{event.title}}",
        "",
        "Achados:",
        `{{steps.${needs}}}`,
      ].join("\n"),
      outputSchema: ISSUE_CONTENT_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      type: "action",
      key: "open_issue",
      name: "Abrir tarefa",
      needs: ["issue_body"],
      optional: false,
      action: "tracker.create_issue",
      // O modo esta escrito aqui por clareza, e nao porque ele possa mudar: o
      // handler recusa qualquer outro, e trocar esta linha faz o passo falhar.
      mode: "approve",
      input: "issue_body",
      target: tracker,
    },
  ];
}
