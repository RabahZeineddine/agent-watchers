import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import {
  fetchAftermath,
  sameSpot,
  touchedAfter,
  type HumanSignal,
  type PrAftermath,
} from "../sources/github-reconciler.js";
import { runService, RunService, type RunFinding } from "./run-service.js";

type Db = typeof defaultDb;

/** Os estados que `finding_outcomes` aceita. */
export type OutcomeState =
  | "confirmed_by_human"
  | "became_commit"
  | "ignored"
  | "disputed"
  | "duplicate";

export interface ReconcileReport {
  runId: string;
  prKey: string;
  state: PrAftermath["state"];
  /** Preenchido quando nada foi gravado, com o motivo. */
  skipped?: string;
  findingCount: number;
  signalCount: number;
  /**
   * Sinal humano que nenhum achado cobriu. E o "nao vi" do agent, e a coluna
   * `missed` das metricas sai daqui.
   */
  unmatchedSignals: number;
  outcomes: Record<OutcomeState, number>;
}

export interface ReconcileOptions {
  /**
   * Reconcilia mesmo com o pull request aberto. Serve para olhar o resultado
   * antes do fim, sabendo que o desfecho ainda pode mudar.
   */
  force?: boolean;
}

export type AftermathFetcher = (
  owner: string,
  repo: string,
  pull: number,
  reviewedSha: string,
) => Promise<PrAftermath>;

/** Achado ja gravado na tabela, que e o que um desfecho pode referenciar. */
interface StoredFinding extends RunFinding {
  id: string;
}

/**
 * Reconciliacao do review humano.
 *
 * O sinal de qualidade nao vem de opiniao registrada na hora, vem do que
 * aconteceu depois: o que um humano apontou no mesmo trecho, o que o humano
 * apontou e o agent nao viu, e se o achado resultou em alteracao de codigo.
 * Por isso a reconciliacao roda quando o pull request fecha, e nao junto da
 * execucao.
 *
 * Gravar aqui e refazivel de proposito: desfecho e dado derivado, entao cada
 * passada apaga o que ela mesma escreveu antes para aquele pull request e
 * escreve de novo. Sem isso, rodar duas vezes dobraria o gabarito e as
 * metricas do N.2 mentiriam.
 */
export class ReconcileService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly runs: RunService = runService,
    private readonly fetch: AftermathFetcher = fetchAftermath,
  ) {}

  async reconcileRun(runId: string, options: ReconcileOptions = {}): Promise<ReconcileReport> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} nao encontrado`);

    const target = await this.prOf(run.eventId);
    const findings = await this.runs.findings(runId);
    const aftermath = await this.fetch(target.owner, target.repo, target.pull, target.headSha);

    const base: ReconcileReport = {
      runId,
      prKey: aftermath.prKey,
      state: aftermath.state,
      findingCount: findings.length,
      signalCount: aftermath.signals.length,
      unmatchedSignals: 0,
      outcomes: zeroed(),
    };

    if (aftermath.state === "open" && options.force !== true) {
      return { ...base, skipped: "pull request aberto: o desfecho ainda pode mudar" };
    }

    const declined = await this.declinedProblems(runId);
    const stored = await this.storeFindings(runId, findings, declined);

    await this.storeSignals(aftermath);

    const outcomes = decide(stored, aftermath, declined);
    await this.storeOutcomes(stored, outcomes);

    const counts = zeroed();
    for (const state of outcomes.values()) counts[state.state] += 1;

    return {
      ...base,
      unmatchedSignals: aftermath.signals.filter(
        (signal) => signal.file !== undefined && !stored.some((f) => sameSpot(f, signal)),
      ).length,
      outcomes: counts,
    };
  }

  /** Dados do pull request que originou o run, direto do evento gravado. */
  private async prOf(eventId: string | null) {
    if (!eventId) throw new Error("run sem evento: nao ha pull request para reconciliar");

    const [event] = await this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    if (!event) throw new Error(`evento ${eventId} nao encontrado`);
    if (event.source !== "github") {
      throw new Error(`evento de origem "${event.source}" nao tem review humano para reconciliar`);
    }

    const p = event.payload as Record<string, unknown>;
    const owner = typeof p.owner === "string" ? p.owner : undefined;
    const repo = typeof p.repoName === "string" ? p.repoName : undefined;
    const pull = typeof p.pull === "number" ? p.pull : undefined;
    if (!owner || !repo || pull === undefined) {
      throw new Error(`evento ${eventId} nao identifica um pull request`);
    }
    return { owner, repo, pull, headSha: typeof p.headSha === "string" ? p.headSha : "" };
  }

  /**
   * Achado citado por uma aprovacao rejeitada. Alguem leu e disse que nao, e
   * isso e sinal mais forte que qualquer inferencia de diff.
   */
  private async declinedProblems(runId: string): Promise<Set<string>> {
    const rows = await this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.runId, runId));

    const out = new Set<string>();
    for (const row of rows) {
      if (row.status !== "rejected") continue;
      const payload = row.payload as { findings?: unknown };
      if (!Array.isArray(payload.findings)) continue;
      for (const item of payload.findings) {
        const problem = (item as { problem?: unknown }).problem;
        if (typeof problem === "string") out.add(problem);
      }
    }
    return out;
  }

  /**
   * Materializa os achados do run na tabela, porque desfecho aponta para linha
   * de `findings` e ate aqui o achado so existia dentro da saida do passo que o
   * produziu. Run ja materializado reaproveita as linhas: apagar quebraria os
   * desfechos de uma passada anterior.
   */
  private async storeFindings(
    runId: string,
    findings: RunFinding[],
    declined: Set<string>,
  ): Promise<StoredFinding[]> {
    const existing = await this.db
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.runId, runId));

    if (existing.length > 0) {
      return existing.map((row) => ({
        id: row.id,
        severity: row.severity,
        file: row.file ?? undefined,
        line: row.line ?? undefined,
        category: row.category ?? undefined,
        problem: row.body,
        state: row.state,
      }));
    }

    const rows = findings.map((f) => ({
      id: randomUUID(),
      runId,
      severity: f.severity,
      category: f.category ?? null,
      file: f.file ?? null,
      line: f.line ?? null,
      // A sugestao entra junto porque e o texto que o revisor humano leu.
      body: f.fix ? `${f.problem}\n\nSugestao: ${f.fix}` : f.problem,
      state: declined.has(f.problem) ? "dismissed" : f.state,
    }));

    if (rows.length > 0) await this.db.insert(schema.findings).values(rows);

    return rows.map((row, i) => ({ ...findings[i]!, id: row.id }));
  }

  private async storeSignals(aftermath: PrAftermath): Promise<void> {
    await this.db.delete(schema.reviewSignals).where(eq(schema.reviewSignals.prKey, aftermath.prKey));
    if (aftermath.signals.length === 0) return;

    await this.db.insert(schema.reviewSignals).values(
      aftermath.signals.map((signal) => ({
        id: randomUUID(),
        prKey: aftermath.prKey,
        author: signal.author,
        kind: signal.kind,
        file: signal.file ?? null,
        line: signal.line ?? null,
        body: signal.body,
        becameCommit: touchedAfter(aftermath.changedAfter, signal),
      })),
    );
  }

  private async storeOutcomes(
    stored: StoredFinding[],
    outcomes: Map<string, Outcome>,
  ): Promise<void> {
    const ids = stored.map((f) => f.id);
    if (ids.length === 0) return;

    await this.db.delete(schema.findingOutcomes).where(inArray(schema.findingOutcomes.findingId, ids));

    const rows = stored
      .map((f) => outcomes.get(f.id))
      .filter((o): o is Outcome => o !== undefined)
      .map((o) => ({
        id: randomUUID(),
        findingId: o.findingId,
        state: o.state,
        evidence: o.evidence,
      }));

    if (rows.length > 0) await this.db.insert(schema.findingOutcomes).values(rows);
  }
}

interface Outcome {
  findingId: string;
  state: OutcomeState;
  evidence: object;
}

/**
 * Desfecho de cada achado, na ordem em que um estado ganha do outro.
 *
 * Duplicata sai primeiro, senao dois achados no mesmo trecho contariam como
 * dois acertos e a precisao subiria de graca. Depois vem o que o humano disse
 * na fila de aprovacao, que e fala explicita. So entao vale o que o review
 * humano apontou, e por ultimo a inferencia pelo diff, que e a evidencia mais
 * fraca das quatro: o trecho pode ter mudado por motivo que nada tem a ver com
 * o achado.
 */
function decide(
  stored: StoredFinding[],
  aftermath: PrAftermath,
  declined: Set<string>,
): Map<string, Outcome> {
  const out = new Map<string, Outcome>();

  stored.forEach((finding, i) => {
    const primary = stored.slice(0, i).find((earlier) => sameSpot(earlier, finding));
    if (primary) {
      out.set(finding.id, {
        findingId: finding.id,
        state: "duplicate",
        evidence: { primaryFindingId: primary.id },
      });
      return;
    }

    if (finding.state === "dismissed" || isDeclined(finding, declined)) {
      out.set(finding.id, {
        findingId: finding.id,
        state: "disputed",
        evidence: { reason: "aprovacao rejeitada" },
      });
      return;
    }

    const signal = aftermath.signals.find((s) => sameSpot(s, finding));
    if (signal) {
      out.set(finding.id, {
        findingId: finding.id,
        state: "confirmed_by_human",
        evidence: { signal: summarize(signal), prKey: aftermath.prKey },
      });
      return;
    }

    if (touchedAfter(aftermath.changedAfter, finding)) {
      out.set(finding.id, {
        findingId: finding.id,
        state: "became_commit",
        evidence: { file: finding.file, line: finding.line, finalSha: aftermath.headSha },
      });
      return;
    }

    out.set(finding.id, {
      findingId: finding.id,
      state: "ignored",
      evidence: { prKey: aftermath.prKey, state: aftermath.state },
    });
  });

  return out;
}

/**
 * Achado que a fila de aprovacao recusou. O prefixo cobre o achado que veio da
 * tabela, onde o texto gravado e o problema com a sugestao colada atras,
 * enquanto a aprovacao guarda so o problema.
 */
function isDeclined(finding: StoredFinding, declined: Set<string>): boolean {
  for (const problema of declined) {
    if (finding.problem === problema || finding.problem.startsWith(problema)) return true;
  }
  return false;
}

/** O corpo inteiro do comentario nao cabe como evidencia, e o inicio basta. */
function summarize(signal: HumanSignal) {
  return {
    author: signal.author,
    kind: signal.kind,
    file: signal.file,
    line: signal.line,
    body: signal.body.length > 400 ? `${signal.body.slice(0, 400)}...` : signal.body,
  };
}

function zeroed(): Record<OutcomeState, number> {
  return {
    confirmed_by_human: 0,
    became_commit: 0,
    ignored: 0,
    disputed: 0,
    duplicate: 0,
  };
}

export const reconcileService = new ReconcileService();
