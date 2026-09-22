import type { ToolSet } from "ai";

export type RuntimeRequest = {
  /** Modelo ja resolvido para esta maquina. */
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  /**
   * Começo de `prompt` que não muda entre eventos. O runtime nativo marca o fim
   * dele para cache; quem não usa pode ignorar, porque o texto já está no prompt.
   */
  stablePrefix?: string;
  /** Ferramentas ja filtradas e renomeadas pelo McpRegistry. */
  tools: ToolSet;
  /** Nomes de servidor usados, para o adaptador de CLI montar --mcp-config. */
  mcpServers?: string[];
  maxSteps: number;
  /** JSON Schema. Presente, a saida e validada. */
  outputSchema?: Record<string, unknown>;
};

export type RuntimeResult = {
  text: string;
  structured?: unknown;
  promptTokens: number;
  completionTokens: number;
  /** Tokens de entrada lidos do cache do provedor. Ausente quando ele não informa. */
  cacheReadTokens?: number;
  costUsd: number;
  /** false quando a execucao gastou cota de assinatura, nao dinheiro. */
  billable: boolean;
  /**
   * false quando o modelo não tem preço cadastrado e `costUsd` é zero por
   * falta de tabela, e não por ser de graça.
   */
  priced?: boolean;
  toolsUsed: string[];
};

export interface Runtime {
  readonly id: string;
  run(req: RuntimeRequest): Promise<RuntimeResult>;
}
