import { ipcMain, type BrowserWindow, type WebContents } from "electron";
import { chatSession } from "./chat.js";
import {
  BRIDGE_CHANNELS,
  type BridgeChannel,
  type LocumApi,
} from "./bridge-contract.js";
import { buildGate } from "../src/executor/build.js";
import { agentService } from "../src/services/agent-service.js";
import { approvalService } from "../src/services/approval-service.js";
import { credentialService } from "../src/services/credential-service.js";
import { machineService } from "../src/services/machine-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { metricsService } from "../src/services/metrics-service.js";
import { providerService } from "../src/services/provider-service.js";
import { runService } from "../src/services/run-service.js";
import { startupService } from "../src/services/startup-service.js";
import { triggerService } from "../src/services/trigger-service.js";
import { refreshTray } from "./tray.js";

export interface BridgeHandlers {
  /** Run para onde o ultimo clique de notificacao mandou. */
  inboxTarget: () => string | null;
}

/**
 * Janelas que o Locum abriu, por id de `webContents`.
 *
 * A ponte so responde a elas. Nao e paranoia gratuita: o dia em que a interface
 * mostrar qualquer coisa de fora, um iframe ou uma janela filha herdariam o
 * preload e passariam a falar pelos mesmos canais. Confiar na origem do pedido
 * e mais barato agora do que depois.
 */
const trusted = new Set<number>();

export function trustWindow(window: BrowserWindow): void {
  const id = window.webContents.id;
  trusted.add(id);
  window.on("closed", () => trusted.delete(id));
}

function assertTrusted(sender: WebContents, channel: BridgeChannel): void {
  if (!trusted.has(sender.id)) {
    throw new Error(`pedido em ${channel} veio de uma janela que nao e do Locum`);
  }
}

/**
 * O que cada canal faz do lado de ca: encaminhar para o servico, e mais nada.
 *
 * Nenhuma regra mora aqui de proposito. Se um dia aparecer um `if` neste mapa,
 * e sinal de que a regra escapou do servico, e a linha de comando e o servidor
 * MCP vao deixar de enxerga-la.
 */
/**
 * Quem pediu e quem recebe o fluxo do chat.
 *
 * Guardado por chamada em vez de vir do `BridgeHandlers`, porque o destino do
 * fluxo e sempre a janela que mandou a mensagem, e nao uma janela fixa
 * escolhida na subida.
 */
let remetente: WebContents | null = null;

function buildHandlers(bridgeHandlers: BridgeHandlers): LocumApi {
  return {
    "agents.list": () => agentService.list(),
    "agents.get": (agentId) => agentService.get(agentId),
    "agents.versions": (agentId) => agentService.listVersions(agentId),
    "agents.budgets": () => agentService.budgets(),

    "runs.list": (filter) => runService.list(filter),
    "runs.get": (runId) => runService.get(runId),
    "runs.findings": (runId) => runService.findings(runId),
    "runs.rerunStep": (runId, stepKey, options) => runService.rerunStep(runId, stepKey, options),

    "approvals.listPending": () => approvalService.listPending(),
    "approvals.get": (approvalId) => approvalService.get(approvalId),
    "approvals.decide": async (approvalId, decision) => {
      if (decision !== "approved" && decision !== "rejected") {
        throw new Error(`decisao "${String(decision)}" nao existe`);
      }
      // A gate recusa pendencia inexistente ou ja resolvida, publica com o
      // externalId que ja estava gravado, e e a unica que fala com o handler de
      // publicacao. A ponte nao repete nada disso: ela leva o clique e volta.
      await buildGate().decide(approvalId, decision);
      await refreshTray();
      return { approvalId, decision };
    },

    // O assistente responde por fluxo, entao `send` volta assim que a conversa
    // comeca. O que chega de volta vai pelo canal de evento.
    "chat.status": () => chatSession.status(),
    "chat.setModel": (modelo) => chatSession.escolher(modelo),
    "chat.send": async (texto) => {
      if (!remetente) throw new Error("sem janela para receber o fluxo");
      await chatSession.enviar(texto, remetente);
    },
    "chat.cancel": async () => chatSession.interromper(),

    "mcp.list": () => mcpService.list(),
    "mcp.test": (name) => mcpService.testConnection(name),
    "mcp.tools": (name) => mcpService.listTools(name),

    "providers.list": async () => providerService.listProviders(),
    "providers.fallbacks": (machine) => providerService.getFallbacks(machine),
    "providers.preview": (models, machine) => providerService.resolvePreviews(models, machine),
    "providers.models": (nome) => providerService.listModels(nome),
    "providers.allModels": () => providerService.listAllModels(),

    "credentials.overview": () => credentialService.overview(),

    "metrics.report": (options) => metricsService.report(options),
    "machine.profile": () => machineService.profile(),

    "triggers.list": (agentId) => triggerService.list(agentId),
    "triggers.setEnabled": (id, enabled) => triggerService.setEnabled(id, enabled),

    "startup.get": () => startupService.getPreference(),
    "startup.set": (enabled) => startupService.setPreference(enabled),

    "window.inboxTarget": async () => bridgeHandlers.inboxTarget(),
  };
}

/** Registra os canais. Devolve quantos ficaram no ar. */
export function setupBridge(bridgeHandlers: BridgeHandlers): number {
  const handlers = buildHandlers(bridgeHandlers);
  const listed = new Set<string>(BRIDGE_CHANNELS);
  const faltando = Object.keys(handlers).filter((k) => !listed.has(k));
  if (faltando.length > 0) {
    throw new Error(`canais fora da lista do contrato: ${faltando.join(", ")}`);
  }

  for (const channel of BRIDGE_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertTrusted(event.sender, channel);
      remetente = event.sender;
      // O cast e inevitavel: o `ipcMain` entrega `unknown[]`, e o tipo de cada
      // canal so existe no contrato. O que sustenta a assinatura e o mapa
      // acima, que compila contra os servicos.
      const call = handlers[channel] as (...a: unknown[]) => Promise<unknown>;
      return call(...args);
    });
  }

  return BRIDGE_CHANNELS.length;
}

export function teardownBridge(): void {
  for (const channel of BRIDGE_CHANNELS) ipcMain.removeHandler(channel);
  trusted.clear();
}

/** Canais no ar agora, para quem precisa conferir sem abrir janela. */
export function bridgeChannelCount(): number {
  return BRIDGE_CHANNELS.length;
}
