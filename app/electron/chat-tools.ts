import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { agentService } from "../src/services/agent-service.js";
import { approvalService } from "../src/services/approval-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { metricsService } from "../src/services/metrics-service.js";
import { providerService } from "../src/services/provider-service.js";
import { runService } from "../src/services/run-service.js";
import { machineService } from "../src/services/machine-service.js";

/**
 * Catalogo do assistente, escrito a mao, uma entrada por vez.
 *
 * Derivar esta lista dos canais da ponte seria mais curto e seria o erro que a
 * emenda 5 do ADR 0003 descreve: o assistente le diff, achado e log, que sao
 * conteudo de terceiro, e uma instrucao plantada la dentro viraria chamada de
 * ferramenta. O que ele nao pode fazer precisa ficar fora por ausencia, nao por
 * filtro que alguem lembra de aplicar.
 *
 * Fora daqui de proposito:
 *
 * - `approvals.decide`, aprovar e rejeitar. Nao e acao da janela, e o clique de
 *   uma pessoa. O assistente pode mostrar a pendencia e propor o texto; quem
 *   decide clica no botao, que fala com a ponte por outro caminho.
 * - `run_agent` e `rerun_step`. Gastam cota e levam minutos. Entram quando
 *   houver confirmacao explicita na propria conversa, nao antes.
 *
 * Gravar agent entra, porque a gravacao vinda de agent ja nasce com teto: passo
 * de acao em rascunho ou automatico volta rebaixado para aprovacao.
 */
export function chatTools(): ToolSet {
  return {
    listar_agents: tool({
      description: "Lista os agents cadastrados, com nome e se estao habilitados.",
      inputSchema: z.object({}),
      execute: async () => agentService.list(),
    }),

    ver_agent: tool({
      description:
        "Detalhe de um agent: a versao mais recente do spec, com passos, modelos, ferramentas e orcamento.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async ({ agentId }) => agentService.getLatestVersion(agentId),
    }),

    versoes_do_agent: tool({
      description: "Historico de versoes de um agent, da mais nova para a mais antiga.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async ({ agentId }) => agentService.listVersions(agentId),
    }),

    listar_execucoes: tool({
      description:
        "Execucoes recentes, opcionalmente filtradas por estado (queued, running, paused, done, failed) ou por agent.",
      inputSchema: z.object({
        status: z.string().optional(),
        agentId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async (filtro) => runService.list(filtro),
    }),

    ver_execucao: tool({
      description:
        "Detalhe de uma execucao: cada passo com modelo usado, substituicao, ferramentas, tokens, custo e erro.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => runService.get(runId),
    }),

    achados_da_execucao: tool({
      description: "Achados de uma execucao, com arquivo, linha, severidade e problema.",
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => runService.findings(runId),
    }),

    fila_de_aprovacao: tool({
      description:
        "Pendencias esperando decisao. Somente leitura: decidir e clique de uma pessoa, nao acao sua.",
      inputSchema: z.object({}),
      execute: async () => approvalService.listPending(),
    }),

    metricas: tool({
      description: "Precisao e concordancia por versao de agent, a partir dos desfechos ja reconciliados.",
      inputSchema: z.object({ agentId: z.string().optional() }),
      execute: async ({ agentId }) => metricsService.report({ agentId }),
    }),

    listar_provedores: tool({
      description: "Provedores de modelo e se estao disponiveis nesta maquina.",
      inputSchema: z.object({}),
      execute: async () => providerService.listProviders(),
    }),

    perfil_da_maquina: tool({
      description: "Identificador desta maquina e a tabela de substituicao de modelo dela.",
      inputSchema: z.object({}),
      execute: async () => machineService.profile(),
    }),

    listar_servidores_mcp: tool({
      description: "Servidores MCP cadastrados, com transporte, escopo e se estao habilitados.",
      inputSchema: z.object({}),
      execute: async () => mcpService.list(),
    }),

    ferramentas_do_servidor: tool({
      description:
        "Ferramentas que um servidor MCP expoe, com descricao e estimativa de tokens do schema de cada uma.",
      inputSchema: z.object({ nome: z.string() }),
      execute: async ({ nome }) => mcpService.listTools(nome),
    }),

    testar_servidor_mcp: tool({
      description: "Conecta num servidor MCP cadastrado e informa se ele respondeu.",
      inputSchema: z.object({ nome: z.string() }),
      execute: async ({ nome }) => mcpService.testConnection(nome),
    }),
  };
}
