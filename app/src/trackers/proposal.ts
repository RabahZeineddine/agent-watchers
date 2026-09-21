import { z } from "zod";

/**
 * O item de tracker que um passo de ação propõe, e o que o passo de modelo
 * antes dele precisa escrever.
 *
 * A divisão entre os dois esquemas é o ponto do arquivo. O modelo escreve
 * prosa, e só prosa: objetivo, o que mudou e o que testar. Título, endereço do
 * pull request e destino são montados aqui, com o que veio do evento e com o
 * que está cadastrado. Um modelo que escolhesse o projeto abriria tarefa no
 * quadro errado, e um que escrevesse o título faria cada card sair com uma cara
 * diferente do anterior.
 */

/** O que o passo de modelo devolve. Sem isto não há corpo para propor. */
export const IssueContent = z.object({
  objective: z.string().trim().min(1),
  changes: z.string().trim().min(1),
  testing: z.string().trim().min(1),
  /** Etiquetas sugeridas. O tracker que não conhecer uma delas é quem recusa. */
  labels: z.array(z.string().trim().min(1)).optional(),
});
export type IssueContent = z.infer<typeof IssueContent>;

/**
 * O esquema de saída do passo de modelo, no formato que o runtime entende.
 *
 * Escrito à mão e não derivado do zod acima de propósito: o que vai para o
 * provedor é JSON Schema puro, e converter o zod aqui arrastaria uma dependência
 * a mais para dentro do processo principal por três campos.
 */
export const ISSUE_CONTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objective", "changes", "testing"],
  properties: {
    objective: { type: "string" },
    changes: { type: "string" },
    testing: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
  },
} as const;

/** O que fica gravado na pendência, e o que a publicação vai receber. */
export const TrackerIssueProposal = z.object({
  /** O tracker cadastrado, tal como o passo declarou em `target`. */
  tracker: z.string().min(1),
  project: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  labels: z.array(z.string()).optional(),
  pullRequestUrl: z.url(),
});
export type TrackerIssueProposal = z.infer<typeof TrackerIssueProposal>;

/** Os campos do evento que o item precisa para se identificar. */
const PullRequest = z.object({
  repo: z.string().min(1),
  pull: z.number().int().positive(),
  title: z.string().min(1),
  url: z.url(),
});

/**
 * O título, no padrão do time.
 *
 * O prefixo com repositório e número não é enfeite: a lista do tracker mostra
 * só o título, e sem ele duas tarefas nascidas de dois pull requests parecidos
 * ficam indistinguíveis na tela de quem vai pegar uma delas.
 */
function titulo(pr: z.infer<typeof PullRequest>): string {
  return `${pr.repo}#${pr.pull}: ${pr.title}`;
}

/**
 * O corpo, com as seções na ordem em que se lê.
 *
 * Os títulos de seção ficam em português cravado, e não no dicionário da
 * interface: este texto não aparece no Locum, ele vai para o quadro do time,
 * onde o resto dos cards está escrito na língua do time. O que muda de card
 * para card é a prosa, e essa vem do modelo.
 */
function corpo(conteudo: IssueContent, pr: z.infer<typeof PullRequest>): string {
  return [
    "## Objetivo",
    "",
    conteudo.objective.trim(),
    "",
    "## O que mudou",
    "",
    conteudo.changes.trim(),
    "",
    "## O que testar",
    "",
    conteudo.testing.trim(),
    "",
    "## Links",
    "",
    `- Pull request: ${pr.url}`,
    `- Arquivos alterados: ${pr.url}/files`,
  ].join("\n");
}

/**
 * Monta o item a partir da saída do passo de modelo e do evento.
 *
 * O `payload` é o que o executor entrega ao passo de ação, que é a saída do
 * passo de que ele depende somada aos campos do evento que nomeiam o alvo. As
 * duas metades são validadas separadas para que a mensagem de erro diga qual
 * delas faltou: modelo que devolveu meio objeto e evento sem endereço de pull
 * request são problemas de gente diferente.
 */
export function buildIssueProposal(
  payload: unknown,
  tracker: string,
  project: string,
): TrackerIssueProposal {
  if (payload === null || typeof payload !== "object") {
    throw new Error("o passo de acao de tarefa recebeu uma saida que nao e objeto");
  }

  const pr = PullRequest.safeParse(payload);
  if (!pr.success) {
    throw new Error(`o evento nao identifica o pull request: ${pr.error.issues[0]?.message ?? ""}`);
  }

  const conteudo = IssueContent.safeParse(payload);
  if (!conteudo.success) {
    const onde = conteudo.error.issues[0];
    throw new Error(
      `o passo de modelo nao escreveu o corpo da tarefa: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
    );
  }

  return TrackerIssueProposal.parse({
    tracker,
    project,
    title: titulo(pr.data),
    body: corpo(conteudo.data, pr.data),
    ...(conteudo.data.labels === undefined ? {} : { labels: conteudo.data.labels }),
    pullRequestUrl: pr.data.url,
  });
}
