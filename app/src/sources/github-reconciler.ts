import { isLocumAuthored, octokit } from "./github.js";

/**
 * Leitura do que aconteceu com um pull request depois que o agent olhou.
 *
 * Aqui so se le do GitHub e se compara texto. Quem grava desfecho e o
 * ReconcileService, porque a regra de como um achado vira confirmado, virou
 * commit ou foi ignorado tambem vale para sinal que venha de outra fonte, e
 * essa regra nao pode morar no adaptador de uma delas.
 */

export type SignalKind = "comment" | "change_request" | "suggestion";

/** O que um revisor humano disse. Serve de gabarito e de corpus. */
export interface HumanSignal {
  author: string;
  kind: SignalKind;
  file?: string;
  line?: number;
  body: string;
}

/**
 * Linhas que mudaram depois do commit que o agent leu, por arquivo. O arquivo
 * mexido sem trecho identificavel aparece com `WHOLE_FILE`.
 */
export type ChangedLines = Map<string, Set<number>>;

/** Apagado, binario ou sem patch na resposta: mexido, sem linha para apontar. */
export const WHOLE_FILE = -1;

export interface PrAftermath {
  prKey: string;
  /** Com `open` o gabarito ainda pode mudar, e nada deve ser gravado. */
  state: "open" | "closed" | "merged";
  /** Commit final do pull request, que pode nao ser o que o agent leu. */
  headSha: string;
  signals: HumanSignal[];
  changedAfter: ChangedLines;
}

/**
 * Tolerancia ao casar linha. Commit depois da review desloca a numeracao, e
 * exigir o numero exato faria achado certo passar por ignorado.
 */
export const LINE_WINDOW = 5;

export interface Spot {
  file?: string;
  line?: number;
}

/** Mesmo trecho, dentro da tolerancia. Sem arquivo dos dois lados nao casa. */
export function sameSpot(a: Spot, b: Spot): boolean {
  if (!a.file || !b.file || a.file !== b.file) return false;
  // Comentario geral do revisor vale para o arquivo inteiro.
  if (a.line === undefined || b.line === undefined) return true;
  return Math.abs(a.line - b.line) <= LINE_WINDOW;
}

/** O trecho saiu do codigo entre o commit lido e o commit final. */
export function touchedAfter(changed: ChangedLines, spot: Spot): boolean {
  if (!spot.file) return false;
  const lines = changed.get(spot.file);
  if (!lines || lines.size === 0) return false;
  if (lines.has(WHOLE_FILE) || spot.line === undefined) return true;
  for (const line of lines) {
    if (Math.abs(line - spot.line) <= LINE_WINDOW) return true;
  }
  return false;
}

/**
 * Ingestao deterministica: sem LLM, sem token gasto. Tudo que esta funcao faz
 * e leitura, e nenhuma chamada daqui escreve no GitHub.
 */
export async function fetchAftermath(
  owner: string,
  repo: string,
  pull: number,
  reviewedSha: string,
): Promise<PrAftermath> {
  const gh = octokit();

  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: pull });
  const reviews = await gh.paginate(gh.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pull,
    per_page: 100,
  });
  const comments = await gh.paginate(gh.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pull,
    per_page: 100,
  });

  const nossas = new Set(reviews.filter((r) => isLocumAuthored(r.body)).map((r) => r.id));

  const signals: HumanSignal[] = [];

  for (const review of reviews) {
    if (nossas.has(review.id)) continue;
    const body = (review.body ?? "").trim();
    // Aprovacao sem texto nao diz nada sobre trecho nenhum.
    if (body.length === 0) continue;
    signals.push({
      author: review.user?.login ?? "desconhecido",
      kind: review.state === "CHANGES_REQUESTED" ? "change_request" : "comment",
      body,
    });
  }

  for (const comment of comments) {
    if (comment.pull_request_review_id && nossas.has(comment.pull_request_review_id)) continue;
    if (isLocumAuthored(comment.body)) continue;
    signals.push({
      author: comment.user?.login ?? "desconhecido",
      kind: comment.body.includes("```suggestion") ? "suggestion" : "comment",
      file: comment.path,
      // `line` some quando o comentario ficou preso a um diff velho; e
      // `original_line` que diz onde ele apontava quando foi escrito.
      line: comment.line ?? comment.original_line ?? undefined,
      body: comment.body,
    });
  }

  return {
    prKey: `${owner}/${repo}#${pull}`,
    state: pr.state === "open" ? "open" : pr.merged_at ? "merged" : "closed",
    headSha: pr.head.sha,
    signals,
    changedAfter:
      reviewedSha && reviewedSha !== pr.head.sha
        ? await changedSince(gh, owner, repo, reviewedSha, pr.head.sha)
        : new Map(),
  };
}

type Gh = ReturnType<typeof octokit>;

/**
 * Linhas que sairam do codigo entre o commit que o agent leu e o commit final.
 *
 * A comparacao vai de `from` para `to`, e as posicoes do lado `-` de cada
 * trecho sao numeradas em `from`, que e exatamente o codigo onde o achado
 * aponta. O lado `+` responderia outra pergunta, a de onde o trecho foi parar.
 */
async function changedSince(
  gh: Gh,
  owner: string,
  repo: string,
  from: string,
  to: string,
): Promise<ChangedLines> {
  const { data } = await gh.rest.repos.compareCommits({ owner, repo, base: from, head: to });

  const out: ChangedLines = new Map();
  for (const file of data.files ?? []) {
    // Arquivo renomeado depois da review guarda o nome antigo, que e o nome
    // que o achado usa.
    const path = file.previous_filename ?? file.filename;
    const lines = out.get(path) ?? new Set<number>();
    for (const [start, count] of removedRanges(file.patch)) {
      for (let i = 0; i < count; i++) lines.add(start + i);
    }
    if (lines.size === 0) lines.add(WHOLE_FILE);
    out.set(path, lines);
  }
  return out;
}

/** Inicio e tamanho do lado `-` de cada trecho do patch. */
function removedRanges(patch: string | undefined): Array<[number, number]> {
  if (!patch) return [];
  const out: Array<[number, number]> = [];
  for (const hunk of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    out.push([Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2])]);
  }
  return out;
}
