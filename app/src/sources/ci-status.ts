import type { Octokit } from "octokit";

/** O que o `checks.listForRef` devolve e o resumo precisa. */
export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  output?: { title?: string | null } | null;
};

export type CheckResult = "passed" | "failed" | "cancelled" | "pending";

export type CiCheck = {
  name: string;
  result: CheckResult;
  conclusion: string | null;
  title?: string;
};

export type CiState = "passing" | "failing" | "pending" | "none" | "unavailable";

export type CiStatus = {
  state: CiState;
  checks: CiCheck[];
  /** O mesmo resultado em texto corrido, pronto para o prompt. */
  summary: string;
};

/** O pedaço do cliente que a leitura dos checks usa. Existe para o teste trocar. */
export type ChecksClient = Pick<Octokit, "paginate"> & {
  rest: { checks: Pick<Octokit["rest"]["checks"], "listForRef"> };
};

const FAILED = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
// Cancelado ou vencido não diz nada sobre o código: alguém parou o check, ou
// um commit novo o tornou velho. Contar como falha faria a auditoria calar
// sobre um defeito que nenhum check chegou a apontar.
const CANCELLED = new Set(["cancelled", "stale"]);

// Título de saída de check às vezes carrega o log inteiro da primeira linha.
const TITLE_MAX = 200;

function classify(run: CheckRun): CheckResult {
  if (run.status !== "completed") return "pending";
  if (run.conclusion !== null && FAILED.has(run.conclusion)) return "failed";
  if (run.conclusion !== null && CANCELLED.has(run.conclusion)) return "cancelled";
  return "passed";
}

function line(c: CiCheck): string {
  const detalhe = c.title ? `: ${c.title}` : "";
  return `- ${c.name} (${c.conclusion ?? "rodando"})${detalhe}`;
}

export function summarizeChecks(runs: CheckRun[]): CiStatus {
  const checks = runs
    .map((run): CiCheck => {
      const title = run.output?.title?.trim().slice(0, TITLE_MAX);
      return { name: run.name, result: classify(run), conclusion: run.conclusion, ...(title ? { title } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (checks.length === 0) {
    return { state: "none", checks, summary: "nenhum check no commit de cabeça" };
  }

  const de = (r: CheckResult) => checks.filter((c) => c.result === r);
  const failed = de("failed");
  const pending = de("pending");
  const cancelled = de("cancelled");

  const state: CiState = failed.length > 0 ? "failing" : pending.length > 0 ? "pending" : "passing";
  const head =
    state === "failing"
      ? `vermelho: ${failed.length} de ${checks.length} checks falharam`
      : state === "pending"
        ? `pendente: ${pending.length} de ${checks.length} checks ainda rodando, nenhum falhou até agora`
        : `verde: nenhum dos ${checks.length} checks falhou`;

  const partes = [head];
  if (failed.length > 0) partes.push(...failed.map(line));
  if (pending.length > 0 && state === "failing") partes.push("Ainda rodando:", ...pending.map(line));
  if (pending.length > 0 && state === "pending") partes.push(...pending.map(line));
  if (cancelled.length > 0) partes.push("Cancelados, sem resultado:", ...cancelled.map(line));

  return { state, checks, summary: partes.join("\n") };
}

/**
 * Os checks do commit de cabeça, na ingestão e sem modelo.
 *
 * Falha de leitura vira estado próprio em vez de derrubar o evento: token de
 * escopo fino sem permissão de checks é comum, e perder a revisão inteira por
 * falta de um contexto opcional seria trocar o principal pelo acessório.
 */
export async function fetchCiStatus(client: ChecksClient, owner: string, repo: string, sha: string): Promise<CiStatus> {
  try {
    const runs = await client.paginate(client.rest.checks.listForRef, {
      owner,
      repo,
      ref: sha,
      filter: "latest",
      per_page: 100,
    });
    return summarizeChecks(runs);
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { state: "unavailable", checks: [], summary: `não foi possível ler os checks: ${motivo}` };
  }
}
