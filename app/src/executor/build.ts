import { ApprovalGate } from "../approval/gate.js";
import { digestDeliverHandler } from "../digest/action.js";
import { Executor } from "./executor.js";
import { McpRegistry } from "../mcp/registry.js";
import { ClaudeCodeRuntime } from "../runtimes/claude-code.js";
import { NativeRuntime } from "../runtimes/native.js";
import type { Runtime } from "../runtimes/types.js";
import { machineId } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { providerService } from "../services/provider-service.js";
import { slackPostHandler } from "../slack/action.js";
import { githubReviewHandler } from "../sources/github.js";
import { trackerIssueHandler } from "../trackers/issue-action.js";

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

  return new Executor({ mcp: new McpRegistry(configs), runtimes, gate: buildGate(), machineId });
}

/**
 * A porta unica de saida, com os handlers que sabem publicar.
 *
 * Mora aqui porque o executor e os exames de fumaça do processo principal
 * precisam da mesma montagem. A decisão da linha de comando e da ponte passa
 * pelo executor, que chama esta gate e retoma o run. Montar o mapa em cada chamador
 * abriria caminho para um deles registrar um handler diferente sem ninguem
 * notar, e a gate so vale como porta unica se ela for sempre a mesma porta.
 */
export function buildGate(): ApprovalGate {
  return new ApprovalGate(
    new Map([
      ["github.review_comment", githubReviewHandler()],
      ["tracker.create_issue", trackerIssueHandler()],
      ["digest.deliver", digestDeliverHandler()],
      ["slack.post", slackPostHandler()],
    ]),
  );
}
