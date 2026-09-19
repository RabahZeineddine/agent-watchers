import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentService } from "../services/agent-service.js";
import { machineId, machineService } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { metricsService } from "../services/metrics-service.js";
import { providerService } from "../services/provider-service.js";
import { runService } from "../services/run-service.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de leitura do servidor MCP.
 *
 * Toda consulta sai da camada de servico, a mesma que a linha de comando usa.
 * O ganho nao e economia de codigo: e que um assistente externo e o dono da
 * maquina enxergam exatamente o mesmo estado, sem uma segunda leitura do banco
 * que pudesse divergir.
 *
 * Nada aqui escreve. Escrita entra no M2.3, e aprovacao e publicacao nao
 * entram nunca, conforme o ADR 0002.
 */
export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_agents",
    {
      description: "Lista os agents cadastrados com a versao mais recente de cada um.",
      inputSchema: {},
    },
    async () => respond(listAgents),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Devolve um agent, o spec da versao mais recente e o historico de versoes.",
      inputSchema: {
        agentId: z.string().describe("identificador do agent, como aparece em list_agents"),
      },
    },
    async ({ agentId }) => respond(() => getAgent(agentId)),
  );

  server.registerTool(
    "list_runs",
    {
      description: "Lista as execucoes mais recentes, opcionalmente filtrando por status ou agent.",
      inputSchema: {
        status: z.string().optional().describe("queued, running, done, paused ou failed"),
        agentId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ status, agentId, limit }) => respond(() => runService.list({ status, agentId, limit })),
  );

  server.registerTool(
    "get_run",
    {
      description: "Devolve uma execucao com os passos e o spec da versao que ela executou.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => respond(() => getRun(runId)),
  );

  server.registerTool(
    "list_findings",
    {
      description:
        "Achados de uma execucao, vindos da tabela ou da saida do passo que os produziu.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => respond(() => runService.findings(runId)),
  );

  server.registerTool(
    "get_metrics",
    {
      description: "Metricas por versao de agent e o gasto diario registrado.",
      inputSchema: {
        agentId: z.string().optional(),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("janela de gasto, contada a partir de hoje"),
      },
    },
    async ({ agentId, days }) => respond(() => metricsService.report({ agentId, days })),
  );

  server.registerTool(
    "list_mcp_servers",
    {
      description:
        "Servidores MCP cadastrados, com transporte, escopo e se estao expostos ao executor.",
      inputSchema: {},
    },
    async () => respond(listMcpServers),
  );

  server.registerTool(
    "list_providers",
    {
      description:
        "Provedores de modelo desta maquina, a tabela de substituicao e, se pedido, onde um modelo cairia.",
      inputSchema: {
        model: z
          .string()
          .optional()
          .describe("modelo no formato provedor/modelo, para ver a resolucao"),
      },
    },
    async ({ model }) => respond(() => listProviders(model)),
  );

  server.registerTool(
    "get_machine_profile",
    {
      description:
        "Retrato desta maquina: identidade, banco, provedores, substituicoes e servidores MCP.",
      inputSchema: {},
    },
    async () => respond(() => machineService.profile()),
  );
}

async function listAgents() {
  const agents = await agentService.list();
  return Promise.all(
    agents.map(async (agent) => {
      const latest = await agentService.getLatestVersion(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        latestVersion: latest?.version ?? null,
        stepCount: latest?.spec.steps.length ?? 0,
      };
    }),
  );
}

async function getAgent(agentId: string) {
  const agent = await agentService.get(agentId);
  if (!agent) throw new Error(`agent "${agentId}" nao cadastrado`);

  const versions = await agentService.listVersions(agentId);
  return {
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    spec: versions[0]?.spec ?? null,
    versions: versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })),
  };
}

async function getRun(runId: string) {
  const run = await runService.get(runId);
  if (!run) throw new Error(`run ${runId} nao encontrado`);
  return run;
}

async function listMcpServers() {
  const entries = await mcpService.list();
  // O nome da credencial pode sair; o segredo mora no keychain e nunca passa por aqui.
  return entries.map(({ config, enabled, credentialRef }) => ({ ...config, enabled, credentialRef }));
}

async function listProviders(model?: string) {
  return {
    providers: providerService.listProviders(),
    fallbacks: await providerService.getFallbacks(machineId),
    resolution:
      model === undefined ? undefined : await providerService.resolvePreview(model, machineId),
  };
}
