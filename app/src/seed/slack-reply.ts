import type { AgentSpec } from "../config/types.js";
import { SLACK_REPLY_SCHEMA } from "../slack/proposal.js";

/**
 * O agent semente que escreve a resposta de uma thread e para na fila.
 *
 * Dois passos, como o de tarefa, e pela mesma razão: o primeiro é de modelo e
 * escreve a prosa, o segundo é de ação e só entrega. Juntar os dois faria o
 * texto nascer dentro da publicação, que é onde ele não pode nascer, porque o
 * que sai assinado por uma pessoa tem que ser legível por ela antes de sair.
 *
 * Sem ferramenta e sem servidor MCP: a mensagem que disparou o run já veio
 * inteira no evento, e dar o Slack ao modelo faria ele sair lendo o canal de
 * novo para escrever uma linha.
 *
 * Não há modo automático aqui nem em lugar nenhum desta ação. O handler recusa
 * qualquer modo que não seja `approve`, e a linha abaixo está escrita por
 * clareza, não porque possa mudar.
 */
export const slackReplySpec: AgentSpec = {
  id: "slack-reply",
  name: "Resposta no Slack",
  defaultTools: [],
  skills: [],
  budget: { perRunUsd: 0.1, perDayUsd: 1 },
  steps: [
    {
      type: "model",
      key: "write",
      name: "Escrever a resposta",
      needs: [],
      optional: false,
      model: "claude-code/claude-sonnet-5",
      maxSteps: 4,
      requiresServers: [],
      prompt: [
        "Escreva a resposta para esta mensagem de Slack, na thread dela.",
        "",
        "Em `text`, a resposta como ela sairia no canal: direta, sem saudação",
        "de e-mail e sem repetir a pergunta. Se faltar informação para",
        "responder, escreva o que falta em vez de supor.",
        "",
        "Em `threadTs`, devolva exatamente o carimbo que veio abaixo. Ele diz",
        "em qual thread a resposta entra, e carimbo trocado é resposta em",
        "conversa alheia.",
        "",
        "Canal: {{event.channel}}",
        "Thread: {{event.threadTs}}",
        "De: {{event.author}}",
        "",
        "Mensagem:",
        "{{event.text}}",
      ].join("\n"),
      outputSchema: SLACK_REPLY_SCHEMA as unknown as Record<string, unknown>,
    },
    {
      type: "action",
      key: "post",
      name: "Responder na thread",
      needs: ["write"],
      optional: false,
      action: "slack.post",
      mode: "approve",
      input: "write",
    },
  ],
};
