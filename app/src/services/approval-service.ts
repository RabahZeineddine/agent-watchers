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
