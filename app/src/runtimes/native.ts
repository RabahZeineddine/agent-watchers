import { generateText, stepCountIs, type LanguageModel } from "ai";
import { buildProviders, type ProviderEntry } from "../providers/registry.js";
import { costOf, priceService, type PriceService } from "../services/price-service.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

/**
 * Runtime padrao: qualquer provedor por chave de API, via AI SDK.
 *
 * A saida estruturada e pedida no prompt e validada aqui, em vez de usar
 * `generateObject`, porque o passo pode ter ferramentas e precisa do laco.
 */
export class NativeRuntime implements Runtime {
  readonly id = "native";

  // Recebe os provedores prontos porque quem monta o executor ja os remontou
  // com o que veio do keychain. Construir aqui de novo leria so o ambiente.
  constructor(
    private readonly providers: Record<string, ProviderEntry> = buildProviders(),
    private readonly prices: Pick<PriceService, "priceFor"> = priceService,
  ) {}

  private modelFor(provider: string, model: string): LanguageModel {
    const entry = this.providers[provider];
    if (!entry?.model) throw new Error(`provider "${provider}" nao expoe modelo de API`);
    return entry.model(model);
  }

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const system = [
      req.system,
      req.outputSchema
        ? `Responda apenas com JSON valido conforme este schema, sem cerca de codigo e sem texto em volta:\n${JSON.stringify(req.outputSchema)}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateText({
      model: this.modelFor(req.provider, req.model),
      system: system.length > 0 ? system : undefined,
      prompt: req.prompt,
      tools: req.tools,
      stopWhen: stepCountIs(req.maxSteps),
    });

    const toolsUsed = new Set<string>();
    for (const step of result.steps ?? []) {
      for (const call of step.toolCalls ?? []) toolsUsed.add(call.toolName);
    }

    // `totalUsage` soma todas as voltas do laço de ferramentas; `usage` seria
    // só a última, e o passo que chamou cinco ferramentas pareceria barato.
    const promptTokens = result.totalUsage?.inputTokens ?? 0;
    const completionTokens = result.totalUsage?.outputTokens ?? 0;
    const price = await this.prices.priceFor(req.provider, req.model);

    return {
      text: result.text,
      structured: req.outputSchema ? parseJson(result.text) : undefined,
      promptTokens,
      completionTokens,
      costUsd: price ? costOf(price, promptTokens, completionTokens) : 0,
      billable: true,
      priced: price !== undefined,
      toolsUsed: [...toolsUsed],
    };
  }
}

/** Modelo as vezes devolve cerca de codigo mesmo mandado nao devolver. */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new Error(`saida nao e JSON valido: ${body.slice(0, 200)}`);
  }
}
