import { ApprovalGate } from "../approval/gate.js";
import { Executor } from "./executor.js";
import { McpRegistry } from "../mcp/registry.js";
import { ClaudeCodeRuntime } from "../runtimes/claude-code.js";
import { NativeRuntime } from "../runtimes/native.js";
import type { Runtime } from "../runtimes/types.js";
import { machineId } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { providerService } from "../services/provider-service.js";
import { githubReviewHandler } from "../sources/github.js";

/**
 * Montagem do executor a partir do que esta cadastrado nesta maquina.
 *
 * Mora fora da linha de comando porque o servico de runs tambem precisa dela
 * para reexecutar um passo, e o servidor MCP vai precisar da mesma montagem.
 */
export async function buildExecutor(): Promise<Executor> {
  // Credencial guardada no keychain entra aqui, antes de qualquer conexao. Sem
  // keychain, ou sem nada guardado, vale o ambiente do processo como sempre.
  await providerService.loadSecrets();

  const servers = await mcpService.enabledConfigs();
  const configs = new Map(servers.map((c) => [c.name, c]));
  const runtimes = new Map<string, Runtime>([["native", new NativeRuntime(providerService.entries())]]);
  if (providerService.isAvailable("claude-code")) runtimes.set("claude-code", new ClaudeCodeRuntime(configs));

  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler()]]));
  return new Executor({ mcp: new McpRegistry(configs), runtimes, gate, machineId });
}
