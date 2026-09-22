import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb, schema } from "../db/index.js";

type Db = typeof defaultDb;

export type ModelPrice = typeof schema.modelPrices.$inferSelect;

export const ModelPriceInput = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  // Zero é preço legítimo, de modelo local ou de gateway que não cobra.
  inputUsdPerMtok: z.number().nonnegative(),
  outputUsdPerMtok: z.number().nonnegative(),
});
export type ModelPriceInput = z.infer<typeof ModelPriceInput>;

/** Quanto um passo custou, dado o preço e o uso que o provedor devolveu. */
export function costOf(price: ModelPrice, promptTokens: number, completionTokens: number): number {
  return (promptTokens * price.inputUsdPerMtok + completionTokens * price.outputUsdPerMtok) / 1_000_000;
}

/**
 * Preço por modelo. Linha de comando, servidor MCP e interface passam por
 * aqui, e o runtime nativo pergunta a cada passo, para que um preço corrigido
 * valha já no passo seguinte e não só depois de remontar o executor.
 */
export class PriceService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(): Promise<ModelPrice[]> {
    return this.db
      .select()
      .from(schema.modelPrices)
      .orderBy(asc(schema.modelPrices.provider), asc(schema.modelPrices.model));
  }

  async priceFor(provider: string, model: string): Promise<ModelPrice | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.modelPrices)
      .where(and(eq(schema.modelPrices.provider, provider), eq(schema.modelPrices.model, model)));
    return row;
  }

  async set(input: ModelPriceInput): Promise<ModelPrice> {
    const parsed = ModelPriceInput.parse(input);
    const updatedAt = Math.floor(Date.now() / 1000);
    const [row] = await this.db
      .insert(schema.modelPrices)
      .values({ ...parsed, updatedAt })
      .onConflictDoUpdate({
        target: [schema.modelPrices.provider, schema.modelPrices.model],
        set: {
          inputUsdPerMtok: parsed.inputUsdPerMtok,
          outputUsdPerMtok: parsed.outputUsdPerMtok,
          updatedAt,
        },
      })
      .returning();
    return row!;
  }

  async remove(provider: string, model: string): Promise<boolean> {
    const removed = await this.db
      .delete(schema.modelPrices)
      .where(and(eq(schema.modelPrices.provider, provider), eq(schema.modelPrices.model, model)))
      .returning();
    return removed.length > 0;
  }
}

export const priceService = new PriceService();
