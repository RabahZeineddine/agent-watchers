import type { ToolSet } from "ai";

export type RuntimeRequest = {
  /** Modelo ja resolvido para esta maquina. */
  provider: string;
  model: string;
  system?: string;
  prompt: string;
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
