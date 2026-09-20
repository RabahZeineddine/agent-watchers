import { desc, eq, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";

type Db = typeof defaultDb;

export type ApprovalRow = typeof schema.approvals.$inferSelect;

/** Pendencia com o passo e o agent que a criaram, que e o que a inbox mostra. */
export interface ApprovalSummary extends ApprovalRow {
  stepKey: string;
  stepName: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
}

/**
 * Leitura da fila de aprovacao. Linha de comando, servidor MCP e interface
 * listam por aqui.
 *
 * A decisao continua na ApprovalGate de proposito: ela e a unica porta de
 * saida, e um servico de consulta que tambem soubesse aprovar abriria um
 * segundo caminho de publicacao. Ver ADR 0002.
 */
export class ApprovalService {
  constructor(private readonly db: Db = defaultDb) {}

  async listPending(): Promise<ApprovalSummary[]> {
    return this.query(eq(schema.approvals.status, "pending"));
  }

  async get(approvalId: string): Promise<ApprovalSummary | undefined> {
    const [row] = await this.query(eq(schema.approvals.id, approvalId));
    return row;
  }

  /**
   * Grava o que vai sair, antes de sair.
   *
   * Editar não é publicar: o texto revisado fica na pendência e continua
   * esperando. Só a ApprovalGate publica, e só depois do clique.
   *
   * Pendência já resolvida não aceita edição. Sem essa trava, alterar o payload
   * depois do envio mudaria o registro do que foi publicado, e o histórico
   * passaria a mentir sobre o que saiu.
   */
  async updatePayload(approvalId: string, payload: unknown): Promise<ApprovalSummary> {
    const [atual] = await this.query(eq(schema.approvals.id, approvalId));
    if (!atual) throw new Error(`aprovacao ${approvalId} nao encontrada`);
    if (atual.status !== "pending") {
      throw new Error(`aprovacao ${approvalId} ja resolvida: ${atual.status}`);
    }

    await this.db
      .update(schema.approvals)
      .set({ payload: payload as object })
      .where(eq(schema.approvals.id, approvalId));

    const [novo] = await this.query(eq(schema.approvals.id, approvalId));
    return novo!;
  }

  private async query(where: SQL): Promise<ApprovalSummary[]> {
    const rows = await this.db
      .select({
        approval: schema.approvals,
        stepKey: schema.steps.stepKey,
        stepName: schema.steps.name,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        agentVersion: schema.agentVersions.version,
      })
      .from(schema.approvals)
      .innerJoin(schema.steps, eq(schema.approvals.stepId, schema.steps.id))
      .innerJoin(schema.runs, eq(schema.approvals.runId, schema.runs.id))
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(where)
      .orderBy(desc(schema.approvals.createdAt));

    return rows.map((r) => ({
      ...r.approval,
      stepKey: r.stepKey,
      stepName: r.stepName,
      agentId: r.agentId,
      agentName: r.agentName,
      agentVersion: r.agentVersion,
    }));
  }
}

export const approvalService = new ApprovalService();
