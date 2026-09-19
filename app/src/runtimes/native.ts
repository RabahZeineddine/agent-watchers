import { generateText, stepCountIs, type LanguageModel } from "ai";
import { buildProviders } from "../providers/registry.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

/**
 * Runtime padrao: qualquer provedor por chave de API, via AI SDK.
 *
 * A saida estruturada e pedida no prompt e validada aqui, em vez de usar
 * `generateObject`, porque o passo pode ter ferramentas e precisa do laco.
 */
export class NativeRuntime implements Runtime {
  readonly id = "native";
  private providers = buildProviders();

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

    return {
      text: result.text,
      structured: req.outputSchema ? parseJson(result.text) : undefined,
      promptTokens: result.usage?.inputTokens ?? 0,
      completionTokens: result.usage?.outputTokens ?? 0,
      costUsd: 0,
      billable: true,
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
