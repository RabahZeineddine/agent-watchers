import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ActionMode } from "../config/types.js";

export type ActionRequest = {
  runId: string;
  stepId: string;
  kind: string;
  payload: unknown;
  /** O `target` do passo, quando ele declarou um. */
  target?: string | null;
};

export type ActionHandler = {
  /**
   * Os modos que esta acao aceita. Ausente vale pelos tres.
   *
   * Existe para a acao que nao pode nascer em outro modo, e a trava ser de
   * codigo e nao de configuracao: quem escreve o agent escolhe o modo, e um
   * campo de spec nao e lugar de decidir se uma tarefa pode ser aberta sem
   * ninguem ver.
   */
  modes?: readonly ActionMode[];
  /**
   * Monta o que vai para a fila a partir da saida do passo.
   *
   * O que este metodo devolve e o que fica gravado na pendencia, e e o que
   * `publish` vai receber depois do clique. Handler que nao implementa manda a
   * saida do passo como ela veio.
   */
  propose?(payload: unknown, target: string | null): Promise<unknown>;
  /** Publica de verdade. Recebe o externalId ja gravado, para ser idempotente. */
  publish(payload: unknown, externalId: string): Promise<void>;
  /** Prepara sem publicar. No GitHub, review em estado pendente. */
  draft?(payload: unknown, externalId: string): Promise<void>;
};

/**
 * Porta unica de saida. Nada que escreve fora passa por outro lugar.
 *
 * `approve` e o padrao. `auto` existe, mas nasce desligado e escopado, e a UI
 * so deve oferece-lo quando as metricas sustentarem. Ha acao que nao aceita os
 * tres, e quem diz isso e o handler, em `modes`: abrir tarefa em nome de uma
 * pessoa nunca e automatico, e uma regra dessas nao pode depender de o modo
 * certo estar escrito na spec.
 */
export class ApprovalGate {
  constructor(private handlers: Map<string, ActionHandler>) {}

  async submit(req: ActionRequest, mode: ActionMode): Promise<"pending" | "drafted" | "published"> {
    const id = randomUUID();
    const externalId = `${req.runId}:${req.stepId}`;
    const handler = this.handlers.get(req.kind);

    // Antes de gravar qualquer coisa: modo recusado nao deixa pendencia orfa na
    // fila, e quem escreveu o agent ve o erro no passo que errou.
    if (handler?.modes !== undefined && !handler.modes.includes(mode)) {
      throw new Error(
        `a acao "${req.kind}" so aceita o modo ${handler.modes.join(", ")}, e o passo pediu "${mode}"`,
      );
    }

    const payload = handler?.propose
      ? await handler.propose(req.payload, req.target ?? null)
      : req.payload;

    await db.insert(schema.approvals).values({
      id,
      runId: req.runId,
      stepId: req.stepId,
      kind: req.kind,
      payload: payload as object,
      status: mode === "approve" ? "pending" : mode === "draft" ? "pending" : "auto",
      externalId,
    });

    if (mode === "approve") return "pending";

    if (!handler) throw new Error(`acao "${req.kind}" sem handler registrado`);

    if (mode === "draft") {
      if (!handler.draft) throw new Error(`acao "${req.kind}" nao suporta modo rascunho`);
      await handler.draft(payload, externalId);
      await this.close(id, "drafted");
      return "drafted";
    }

    await handler.publish(payload, externalId);
    await this.close(id, "approved");
    return "published";
  }

  /** Chamado pela inbox quando voce clica. */
  async decide(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!row) throw new Error(`aprovacao ${approvalId} nao encontrada`);
    if (row.status !== "pending") throw new Error(`aprovacao ${approvalId} ja resolvida: ${row.status}`);

    if (decision === "approved") {
      const handler = this.handlers.get(row.kind);
      if (!handler) throw new Error(`acao "${row.kind}" sem handler registrado`);
      // externalId ja esta gravado: retry depois de crash nao publica duas vezes.
      await handler.publish(row.payload, row.externalId!);
    }
    await this.close(approvalId, decision);
  }

  private async close(id: string, status: string): Promise<void> {
    await db
      .update(schema.approvals)
      .set({ status, decidedAt: Math.floor(Date.now() / 1000) })
      .where(eq(schema.approvals.id, id));
  }
}
