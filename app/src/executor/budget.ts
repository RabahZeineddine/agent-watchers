import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AgentBudget } from "../config/types.js";

export class BudgetExceeded extends Error {
  constructor(scope: "run" | "day", unit: "usd" | "tokens", limit: number, spent: number) {
    const fmt = (n: number) => (unit === "usd" ? `${n.toFixed(2)} USD` : `${Math.round(n)} tokens`);
    super(`orçamento de ${scope} estourado: limite ${fmt(limit)}, gasto ${fmt(spent)}`);
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Gasto em dinheiro e em tokens dos passos cobrados. */
export type Spend = { usd: number; tokens: number };

/**
 * Checado antes de cada passo de modelo, nao so no comeco do run.
 *
 * `unrecorded` é o que este trecho já gastou e ainda não foi para
 * `usage_daily`, que só recebe o gasto na saída do trecho. Sem somar isso, um
 * run longo passaria do teto do dia sem ver o próprio gasto.
 */
export async function assertWithinBudget(
  agentId: string,
  run: Spend,
  unrecorded: Spend,
  limits: AgentBudget,
): Promise<void> {
  if (limits.perRunUsd !== undefined && run.usd >= limits.perRunUsd) {
    throw new BudgetExceeded("run", "usd", limits.perRunUsd, run.usd);
  }
  if (limits.perRunTokens !== undefined && run.tokens >= limits.perRunTokens) {
    throw new BudgetExceeded("run", "tokens", limits.perRunTokens, run.tokens);
  }
  if (limits.perDayUsd === undefined && limits.perDayTokens === undefined) return;

  const [row] = await db
    .select()
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.day, today()), eq(schema.usageDaily.agentId, agentId)));

  const usd = (row?.costUsd ?? 0) + unrecorded.usd;
  if (limits.perDayUsd !== undefined && usd >= limits.perDayUsd) {
    throw new BudgetExceeded("day", "usd", limits.perDayUsd, usd);
  }
  const tokens = (row?.tokens ?? 0) + unrecorded.tokens;
  if (limits.perDayTokens !== undefined && tokens >= limits.perDayTokens) {
    throw new BudgetExceeded("day", "tokens", limits.perDayTokens, tokens);
  }
}

/**
 * Soma no dia o que um trecho de execução gastou.
 *
 * Chamado uma vez por trecho, em qualquer saída: um run que pausa na fila e é
 * retomado depois gasta em dois trechos, e só o primeiro conta como execução.
 */
export async function recordSpend(agentId: string, spend: Spend, newRun: boolean): Promise<void> {
  if (!newRun && spend.usd === 0 && spend.tokens === 0) return;
  const day = today();
  const runs = newRun ? 1 : 0;
  await db
    .insert(schema.usageDaily)
    .values({ day, agentId, costUsd: spend.usd, tokens: spend.tokens, runs })
    .onConflictDoUpdate({
      target: [schema.usageDaily.day, schema.usageDaily.agentId],
      set: {
        costUsd: sql`${schema.usageDaily.costUsd} + ${spend.usd}`,
        tokens: sql`${schema.usageDaily.tokens} + ${spend.tokens}`,
        runs: sql`${schema.usageDaily.runs} + ${runs}`,
      },
    });
}
