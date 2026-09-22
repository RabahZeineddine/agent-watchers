import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executionService } from "../services/execution-service.js";
import { runService } from "../services/run-service.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de execucao do servidor MCP.
 *
 * Disparar e diferente de publicar. O run roda, os achados ficam no banco, e o
 * passo de acao para na fila de aprovacao esperando decisao humana. Nenhuma
 * ferramenta daqui decide por essa fila, conforme o ADR 0002.
 *
 * As duas nao esperam o pipeline terminar por padrao. Uma execucao completa
 * leva minutos e estoura o tempo de espera do cliente; o identificador volta na
 * hora e o andamento sai por `get_run`.
 */
export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "run_agent",
    {
      description:
        "Dispara um agent contra um pull request ou contra o evento sintetico. Devolve o identificador do run; o andamento sai por get_run.",
      inputSchema: {
        target: z
          .string()
          .describe(
            '"owner/repo#123" para alvo real, "sintetico" para o evento de fumaca com defeito plantado ou "sintetico-limpo" para o diff correto',
          ),
        agentId: z
          .string()
          .optional()
          .describe("ausente usa o agent semente; a versao e sempre a mais recente"),
        wait: z
          .boolean()
          .optional()
          .describe("verdadeiro segura a resposta ate o run parar, o que pode levar minutos"),
      },
    },
    async ({ target, agentId, wait }) =>
      respond(() => executionService.start({ target, agentId, wait: wait ?? false })),
  );

  server.registerTool(
    "rerun_step",
    {
      description:
        "Zera um passo e todos que dependem dele, e roda o run de novo a partir dali. O custo dos passos zerados sai do total.",
      inputSchema: {
        runId: z.string(),
        stepKey: z.string().describe("chave do passo no spec, como aparece em get_run"),
        wait: z.boolean().optional().describe("verdadeiro segura a resposta ate o run parar"),
      },
    },
    async ({ runId, stepKey, wait }) =>
      respond(async () => ({
        runId,
        stepKey,
        status: await runService.rerunStep(runId, stepKey, { wait: wait ?? false }),
      })),
  );
}
