import type { AgentSpec } from "../config/types.js";

/**
 * Agent semente da v1.
 *
 * Os modelos sao concretos de proposito: o passo nunca muda, quem muda e a
 * tabela de fallback da maquina. Numa maquina sem assinatura, os dois primeiros
 * passos caem para glm e gemini sem tocar nesta definicao.
 */
export const prReviewSpec: AgentSpec = {
  id: "pr-review",
  name: "PR Review",
  defaultTools: [],
  skills: [
    { skill: "escrita-do-time", when: { always: true } },
    { skill: "dotnet", when: { filesMatch: ["**/*.cs", "**/*.csproj"] } },
    { skill: "front-fiel-ao-design", when: { filesMatch: ["**/*.tsx", "**/*.jsx", "**/*.css"] } },
  ],
  budget: { perRunUsd: 0.4, perDayUsd: 6 },
  steps: [
    {
      type: "model",
      key: "triage",
      name: "Triagem",
      needs: [],
      optional: false,
      model: "claude-code/claude-sonnet-5",
      maxSteps: 4,
      requiresServers: [],
      prompt: [
        "Voce faz a triagem de um pull request, sem julgar merito ainda.",
        "",
        "Repositorio: {{event.repo}}",
        "Titulo: {{event.title}}",
        "Descricao: {{event.description}}",
        "",
        "Diff:",
        "{{event.diff}}",
        "",
        "Classifique o escopo, aponte as areas de risco e liste os arquivos que",
        "merecem leitura atenta na auditoria.",
      ].join("\n"),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "risk_areas", "files_to_read"],
        properties: {
          scope: { type: "string" },
          risk_areas: { type: "array", items: { type: "string" } },
          files_to_read: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      type: "model",
      key: "audit",
      name: "Auditoria",
      needs: ["triage"],
      optional: false,
      model: "claude-code/claude-opus-5",
      maxSteps: 16,
      requiresServers: [],
      prompt: [
        "Audite este pull request procurando defeito real de correcao.",
        "Nada de observacao cosmetica, nada de elogio.",
        "Cada achado precisa de arquivo, linha e um cenario concreto de falha.",
        "Se nao houver defeito, devolva a lista vazia.",
        "",
        "Triagem:",
        "{{steps.triage}}",
        "",
        "Diff:",
        "{{event.diff}}",
      ].join("\n"),
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["severity", "problem"],
              properties: {
                file: { type: "string" },
                line: { type: "integer" },
                severity: { enum: ["critical", "high", "medium", "low"] },
                category: { type: "string" },
                problem: { type: "string" },
                fix: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      type: "model",
      key: "deploy_context",
      name: "Contexto de deploy",
      needs: ["audit"],
      // Opcional de proposito: no PC sem VPN o passo e pulado e o run segue.
      optional: true,
      model: "claude-code/claude-sonnet-5",
      maxSteps: 8,
      requiresServers: ["argocd"],
      prompt: [
        "Verifique se houve deploy recente do servico afetado e se algum achado",
        "critico ja esta em producao.",
        "",
        "Achados:",
        "{{steps.audit}}",
      ].join("\n"),
    },
    {
      type: "action",
      key: "post",
      name: "Comentar no PR",
      needs: ["audit"],
      optional: false,
      action: "github.review_comment",
      // Nasce em aprovacao: nada sai sem clique. Trocar para "draft" faz o
      // agent montar a review pendente direto no GitHub, visivel so para voce.
      mode: "approve",
      input: "audit",
    },
  ],
};

/** Fallback da maquina sem assinatura. Local, nao vai para o git. */
export const fallbacksSemAssinatura = [
  { fromModel: "claude-code/claude-opus-5", toModel: "google/gemini-2.5-pro", order: 0 },
  { fromModel: "claude-code/claude-sonnet-5", toModel: "glm/glm-4.6", order: 0 },
  { fromModel: "google/gemini-2.5-pro", toModel: "glm/glm-4.6", order: 1 },
];
