import { randomUUID } from "node:crypto";
import { Octokit } from "octokit";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ActionHandler } from "../approval/gate.js";
import type { ReviewFinding } from "../config/types.js";
import type { EventPayload } from "../executor/executor.js";
import { GITHUB_TOKEN_ENV, githubService, githubToken } from "../services/github-service.js";
import { limitDiff, type OmittedFile } from "./diff-limit.js";

export type Finding = ReviewFinding;

export type ReviewPayload = { owner: string; repo: string; pull: number; findings: Finding[] };

/**
 * O cliente autenticado, com o token vindo do cofre ou do ambiente.
 *
 * Quem decide de onde o token sai é o `githubToken`, e não este arquivo: a
 * mesma ordem vale para a varredura, para a ingestão e para a publicação, e
 * repetir a decisão aqui faria um desses três caminhos ficar para trás no dia
 * em que ela mudasse.
 */
export function octokit(): Octokit {
  const auth = githubToken();
  if (auth === undefined) {
    throw new Error(
      `sem token do GitHub: guarde um na configuração ou exporte ${GITHUB_TOKEN_ENV}`,
    );
  }
  return new Octokit({ auth });
}

export type PrContext = EventPayload & {
  owner: string;
  repoName: string;
  pull: number;
  title: string;
  description: string;
  diff: string;
  /**
   * O que ficou fora do diff e por quê.
   *
   * Opcional porque evento gravado antes do corte não tem, e reexecutar um
   * desses não pode quebrar por falta de campo.
   */
  omittedFiles?: OmittedFile[];
  omittedSummary?: string;
  headSha: string;
  /**
   * Quem abriu, para onde vai e o tamanho da mudança.
   *
   * Nada disso entra no prompt: serve para a fila e para a lista de execuções
   * dizerem de que trabalho se trata sem obrigar a abrir o pull request. Uma
   * linha que diz só "PR #482" obriga a sair do aplicativo para saber se vale
   * olhar agora.
   */
  author: string;
  baseBranch: string;
  headBranch: string;
  url: string;
  additions: number;
  deletions: number;
  fileCount: number;
  draft: boolean;
};

/** Ingestao deterministica: sem LLM, sem token gasto. */
export async function fetchPr(owner: string, repo: string, pull: number): Promise<PrContext> {
  const gh = octokit();

  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: pull });
  const files = await gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: pull, per_page: 100 });

  const { diff, omittedFiles, omittedSummary } = limitDiff(files, await githubService.diffMaxChars());

  return {
    repo: `${owner}/${repo}`,
    owner,
    repoName: repo,
    pull,
    title: pr.title,
    description: pr.body ?? "",
    headSha: pr.head.sha,
    changedFiles: files.map((f) => f.filename),
    diff,
    omittedFiles,
    omittedSummary,
    author: pr.user?.login ?? "desconhecido",
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    url: pr.html_url,
    additions: pr.additions,
    deletions: pr.deletions,
    fileCount: files.length,
    draft: pr.draft ?? false,
  };
}

/**
 * Varredura por cursor. Intervalo fixo perde a janela quando o Mac dorme; o
 * cursor recupera tudo que passou, e o indice unico de evento mata duplicata.
 */
export async function pollOpenPullRequests(owner: string, repoFilter: RegExp): Promise<string[]> {
  const gh = octokit();
  const source = "github";
  const key = `prs:${owner}`;

  const [cursor] = await db
    .select()
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, key)));

  const since = cursor?.value ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const query = `is:pr is:open org:${owner} updated:>=${since.slice(0, 10)}`;
  const { data } = await gh.rest.search.issuesAndPullRequests({ q: query, per_page: 50 });

  const created: string[] = [];
  let newest = since;

  for (const item of data.items) {
    const repo = item.repository_url.split("/").pop()!;
    if (!repoFilter.test(`${owner}/${repo}`)) continue;
    if (item.updated_at > newest) newest = item.updated_at;

    const ctx = await fetchPr(owner, repo, item.number);
    const id = randomUUID();
    const inserted = await db
      .insert(schema.events)
      .values({
        id,
        source,
        externalId: `pr:${owner}/${repo}#${item.number}:sha:${ctx.headSha}`,
        payload: ctx as object,
      })
      .onConflictDoNothing()
      .returning({ id: schema.events.id });

    if (inserted.length > 0) created.push(id);
  }

  // Cursor avanca so depois de gravar, senao um crash no meio perde eventos.
  await db
    .insert(schema.cursors)
    .values({ source, key, value: newest })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value: newest, updatedAt: Math.floor(Date.now() / 1000) },
    });

  return created;
}

/**
 * Marca invisivel no corpo do que o Locum publica. O token e pessoal, entao a
 * review automatica sai assinada pela mesma conta que revisa a mao: sem a marca
 * o reconciliador leria o proprio achado como confirmacao humana dele mesmo.
 */
export const LOCUM_MARKER = "<!-- locum -->";

/** Review ou comentario que saiu daqui. Sem a marca, conta como humano. */
export function isLocumAuthored(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(LOCUM_MARKER);
}

const SEVERITY_MARK: Record<Finding["severity"], string> = {
  critical: "critico",
  high: "alto",
  medium: "medio",
  low: "baixo",
};

function renderBody(findings: Finding[]): string {
  if (findings.length === 0) return `Revisao automatica: nenhum achado.\n\n${LOCUM_MARKER}`;
  const corpo = findings
    .map((f) => {
      const local = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "geral";
      const fix = f.fix ? `\n\nSugestao: ${f.fix}` : "";
      return `**${local}** (${SEVERITY_MARK[f.severity]})\n\n${f.problem}${fix}`;
    })
    .join("\n\n---\n\n");
  return `${corpo}\n\n${LOCUM_MARKER}`;
}

/**
 * Handler da acao de review.
 *
 * O modo rascunho usa o proprio mecanismo do GitHub: review criada sem `event`
 * fica em estado pendente, visivel so para quem criou. Voce abre o PR, le e
 * envia. Nada publico antes disso.
 */
export function githubReviewHandler(): ActionHandler {
  const comments = (findings: Finding[]) =>
    findings
      .filter((f): f is Finding & { file: string; line: number } => Boolean(f.file && f.line))
      .map((f) => ({
        path: f.file,
        line: f.line,
        body: `**${SEVERITY_MARK[f.severity]}**: ${f.problem}${f.fix ? `\n\nSugestao: ${f.fix}` : ""}\n\n${LOCUM_MARKER}`,
      }));

  return {
    async publish(payload) {
      const p = payload as ReviewPayload;
      await octokit().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        event: "COMMENT",
        body: renderBody(p.findings),
        comments: comments(p.findings),
      });
    },
    async draft(payload) {
      const p = payload as ReviewPayload;
      await octokit().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        body: renderBody(p.findings),
        comments: comments(p.findings),
      });
    },
  };
}
