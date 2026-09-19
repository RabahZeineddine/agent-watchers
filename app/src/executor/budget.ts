import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export class BudgetExceeded extends Error {
  constructor(scope: "run" | "day", limit: number, spent: number) {
    super(`orcamento de ${scope} estourado: limite ${limit.toFixed(2)}, gasto ${spent.toFixed(2)}`);
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Checado antes de cada passo de modelo, nao so no comeco do run. */
export async function assertWithinBudget(
  agentId: string,
  runCost: number,
  limits: { perRunUsd?: number; perDayUsd?: number },
): Promise<void> {
  if (limits.perRunUsd !== undefined && runCost >= limits.perRunUsd) {
    throw new BudgetExceeded("run", limits.perRunUsd, runCost);
  }
  if (limits.perDayUsd === undefined) return;

  const [row] = await db
    .select()
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.day, today()), eq(schema.usageDaily.agentId, agentId)));

  const spent = row?.costUsd ?? 0;
  if (spent >= limits.perDayUsd) throw new BudgetExceeded("day", limits.perDayUsd, spent);
}

export async function recordSpend(agentId: string, costUsd: number): Promise<void> {
  const day = today();
  await db
    .insert(schema.usageDaily)
    .values({ day, agentId, costUsd, runs: 1 })
    .onConflictDoUpdate({
      target: [schema.usageDaily.day, schema.usageDaily.agentId],
      set: {
        costUsd: sql`${schema.usageDaily.costUsd} + ${costUsd}`,
        runs: sql`${schema.usageDaily.runs} + 1`,
      },
    });
}
