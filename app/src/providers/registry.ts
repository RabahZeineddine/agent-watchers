import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { execFileSync } from "node:child_process";

/**
 * Identificador de modelo e sempre "provider/model-id".
 * O provider "claude-code" nao e um provider de API: e o runtime que gasta a
 * assinatura Max, e por isso nao expoe LanguageModel.
 */
export type ModelId = `${string}/${string}`;

export function splitModelId(id: string): { provider: string; model: string } {
  const at = id.indexOf("/");
  if (at < 1) throw new Error(`model id invalido: "${id}", esperado "provider/model"`);
  return { provider: id.slice(0, at), model: id.slice(at + 1) };
}

export type ProviderEntry = {
  /** Sem credencial, o provider simplesmente nao existe nesta maquina. */
  available: () => boolean;
  /**
   * Variaveis de ambiente que precisam estar presentes. Vazio quando a
   * disponibilidade nao vem do ambiente, como no binario da assinatura.
   */
  requires: string[];
  model?: (id: string) => LanguageModel;
  /**
   * Onde perguntar quais modelos existem. O catalogo e do provedor, e um
   * gateway expoe o que quiser: lista fixa no codigo envelhece e mente.
   */
  catalog?: () => { url: string; headers: Record<string, string> };
};

/**
 * Variavel de ambiente que o `credential_ref` de cada provider preenche.
 *
 * `claude-code` e `ollama` ficam de fora de proposito: um vive da sessao do
 * binario e o outro roda local, entao nenhum dos dois tem segredo a guardar.
 * Nos compativeis com OpenAI so a chave vem do keychain; a URL base nao e
 * segredo e continua no ambiente.
 */
export const PROVIDER_SECRET_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  glm: "GLM_API_KEY",
  gateway: "GATEWAY_API_KEY",
};

let claudeBinaryChecked: boolean | undefined;

/** Binario presente e sessao valida. Sem isso a via de assinatura nao existe. */
export function claudeCodeAvailable(): boolean {
  if (claudeBinaryChecked !== undefined) return claudeBinaryChecked;
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 5000 });
    claudeBinaryChecked = true;
  } catch {
    claudeBinaryChecked = false;
  }
  return claudeBinaryChecked;
}

/**
 * `secrets` vem do keychain, indexado por variavel de ambiente, e vence o
 * ambiente do processo: quem cadastrou a chave pelo app nao deveria precisar
 * exportar nada no shell. Sem nada guardado, tudo se comporta como antes.
 */
export function buildProviders(secrets: Record<string, string> = {}): Record<string, ProviderEntry> {
  const env = (name: string): string | undefined => {
    const v = secrets[name] ?? process.env[name];
    return v && v.length > 0 ? v : undefined;
  };

  const compat = (name: string, keyVar: string, urlVar: string) => {
    const apiKey = env(keyVar);
    const baseURL = env(urlVar);
    return {
      available: () => Boolean(apiKey && baseURL),
      requires: [keyVar, urlVar],
      model: (id: string) =>
        createOpenAICompatible({ name, apiKey: apiKey!, baseURL: baseURL! }).chatModel(id),
      catalog: () => ({
        url: `${baseURL!.replace(/\/$/, "")}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    } satisfies ProviderEntry;
  };

  return {
    "claude-code": { available: claudeCodeAvailable, requires: [] },

    anthropic: {
      available: () => Boolean(env("ANTHROPIC_API_KEY")),
      requires: ["ANTHROPIC_API_KEY"],
      model: (id) => createAnthropic({ apiKey: env("ANTHROPIC_API_KEY")! })(id),
      catalog: () => ({
        url: "https://api.anthropic.com/v1/models",
        headers: {
          "x-api-key": env("ANTHROPIC_API_KEY")!,
          "anthropic-version": "2023-06-01",
        },
      }),
    },
    openai: {
      available: () => Boolean(env("OPENAI_API_KEY")),
      requires: ["OPENAI_API_KEY"],
      model: (id) => createOpenAI({ apiKey: env("OPENAI_API_KEY")! })(id),
      catalog: () => ({
        url: "https://api.openai.com/v1/models",
        headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
      }),
    },
    google: {
      available: () => Boolean(env("GOOGLE_GENERATIVE_AI_API_KEY")),
      requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
      model: (id) => createGoogleGenerativeAI({ apiKey: env("GOOGLE_GENERATIVE_AI_API_KEY")! })(id),
    },

    glm: compat("glm", "GLM_API_KEY", "GLM_BASE_URL"),
    gateway: compat("gateway", "GATEWAY_API_KEY", "GATEWAY_BASE_URL"),

    ollama: {
      available: () => Boolean(env("OLLAMA_BASE_URL")),
      requires: ["OLLAMA_BASE_URL"],
      model: (id) =>
        createOpenAICompatible({ name: "ollama", apiKey: "ollama", baseURL: env("OLLAMA_BASE_URL")! }).chatModel(id),
      catalog: () => ({
        url: `${env("OLLAMA_BASE_URL")!.replace(/\/$/, "")}/models`,
        headers: {},
      }),
    },
  };
}

export type ModelResolution = {
  requested: string;
  used: string;
  provider: string;
  model: string;
  substitutionReason?: string;
};

export type FallbackRow = { fromModel: string; toModel: string; order: number };

/**
 * Resolve o modelo do passo nesta maquina. O passo nunca muda, so a tabela.
 * Cadeia sem saida devolve erro em vez de escolher sozinho.
 */
export function resolveModel(
  requested: string,
  fallbacks: FallbackRow[],
  providers: Record<string, ProviderEntry> = buildProviders(),
): ModelResolution {
  const seen = new Set<string>();
  let current = requested;
  let hops = 0;

  while (!seen.has(current)) {
    seen.add(current);
    const { provider, model } = splitModelId(current);
    const entry = providers[provider];

    if (entry?.available()) {
      return {
        requested,
        used: current,
        provider,
        model,
        substitutionReason:
          hops === 0 ? undefined : `${requested} indisponivel nesta maquina, ${hops} substituicao(oes)`,
      };
    }

    const next = fallbacks
      .filter((f) => f.fromModel === current)
      .sort((a, b) => a.order - b.order)
      .find((f) => !seen.has(f.toModel));

    if (!next) {
      throw new Error(
        `modelo "${requested}" indisponivel nesta maquina e sem fallback restante (parou em "${current}")`,
      );
    }
    current = next.toModel;
    hops += 1;
  }

  throw new Error(`ciclo na tabela de fallback a partir de "${requested}"`);
}
