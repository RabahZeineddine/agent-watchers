import type { AgentSpec } from "../config/types.js";
import { DIGEST_READING_SCHEMA } from "../digest/proposal.js";

/**
 * O agent semente que lê a conversa do dia e devolve um digest.
 *
 * Um passo de modelo e um passo de ação, e nada de ferramenta: o que ele lê já
 * chegou agrupado no evento, montado pela ingestão determinística. Dar
 * servidor MCP a ele faria o modelo sair perguntando o canal de novo, que é
 * exatamente o gasto que a ingestão existe para evitar.
 *
 * O modelo é o mais barato do catálogo de propósito. Classificar assunto que
 * já veio separado por canal e por thread não é trabalho de modelo grande, e
 * este agent roda todo dia.
 *
 * Não há passo de saída. O digest para na fila como proposta de leitura, e
 * responder no Slack é outro agent, com outro passo, que também para lá.
 */
export const slackDigestSpec: AgentSpec = {
  id: "slack-digest",
  name: "Digest do Slack",
  defaultTools: [],
  skills: [],
  budget: { perRunUsd: 0.1, perDayUsd: 1 },
  steps: [
    {
      type: "model",
      key: "read",
      name: "Leitura",
      needs: [],
      optional: false,
      model: "claude-code/claude-sonnet-5",
      maxSteps: 4,
      requiresServers: [],
      prompt: [
        "Você recebe a conversa que chegou desde a última entrega, já agrupada",
        "por canal e por thread. Escreva o digest.",
        "",
        "Para cada assunto, diga em `kind` o que ele é:",
        "`needs_reply` quando alguém espera resposta de quem vai ler,",
        "`info` quando é para saber e não exige nada,",
        "`ignore` quando não muda nada para quem vai ler.",
        "",
        "Em `summary`, o que aconteceu no assunto, em uma ou duas frases.",
        "Em `subject`, o assunto da thread como ele se lê, não o texto inteiro.",
        "Em `channel`, o canal exatamente como ele veio.",
        "",
        "Não invente canal, não invente thread, e não resuma o que não veio: o",
        "que ficou fora do recorte aparece como `more` e não é seu para supor.",
        "",
        "Conversa:",
        "{{event.channels}}",
      ].join("\n"),
      outputSchema: DIGEST_READING_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      type: "action",
      key: "deliver",
      name: "Entregar o digest",
      needs: ["read"],
      optional: false,
      action: "digest.deliver",
      // Escrito aqui por clareza, e não porque possa mudar: o handler recusa
      // qualquer outro modo, e trocar esta linha faz o passo falhar.
      mode: "approve",
      input: "read",
    },
  ],
};
