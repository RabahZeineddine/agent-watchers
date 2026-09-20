import type { AgentService } from "../src/services/agent-service.js";
import type { ApprovalService } from "../src/services/approval-service.js";
import type { MachineService } from "../src/services/machine-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { MetricsService } from "../src/services/metrics-service.js";
import type { ProviderService } from "../src/services/provider-service.js";
import type { RunService } from "../src/services/run-service.js";
import type { StartupService } from "../src/services/startup-service.js";
import type { TriggerService } from "../src/services/trigger-service.js";

/**
 * Contrato da ponte entre a janela e a camada de servico.
 *
 * Este arquivo e o unico que os dois lados importam, e ele nao tem import de
 * valor: so tipo e a lista de canais. Isso importa porque o preload roda em
 * sandbox, onde nao existe nem banco nem `node_modules` para carregar, e um
 * import de valor vindo de `src/` arrastaria o nucleo inteiro para dentro dele.
 *
 * Cada canal e tipado pelo metodo do servico que ele encaminha. Mudar a
 * assinatura de um servico quebra a compilacao da ponte, que e o ponto: a
 * janela nao tem contrato proprio, ela consome o dos servicos.
 */

/** Todo canal atravessa IPC, entao o que era sincrono volta como promessa. */
type Asyncify<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export interface DecisionResult {
  approvalId: string;
  decision: "approved" | "rejected";
}

interface ServiceApi {
  "agents.list": AgentService["list"];
  "agents.get": AgentService["get"];
  "agents.versions": AgentService["listVersions"];

  "runs.list": RunService["list"];
  "runs.get": RunService["get"];
  "runs.findings": RunService["findings"];
  "runs.rerunStep": RunService["rerunStep"];

  "approvals.listPending": ApprovalService["listPending"];
  "approvals.get": ApprovalService["get"];
  /**
   * O clique de uma pessoa na inbox, e nada alem disso.
   *
   * A janela manda um identificador de pendencia que o executor ja gravou e um
   * sim ou um nao. Ela nao monta o que vai ser publicado, nao escolhe o destino
   * e nao alcanca o handler de publicacao: quem publica continua sendo a
   * ApprovalGate, do outro lado da ponte, que e a porta unica do ADR 0002.
   */
  "approvals.decide": (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => Promise<DecisionResult>;

  "mcp.list": McpService["list"];
  "mcp.test": McpService["testConnection"];
  "mcp.tools": McpService["listTools"];

  "providers.list": ProviderService["listProviders"];
  "providers.fallbacks": ProviderService["getFallbacks"];
  /** Onde cada modelo do spec cai nesta maquina. So conta, nao dispara nada. */
  "providers.preview": ProviderService["resolvePreviews"];

  "metrics.report": MetricsService["report"];
  "machine.profile": MachineService["profile"];

  "triggers.list": TriggerService["list"];
  "triggers.setEnabled": TriggerService["setEnabled"];

  "startup.get": StartupService["getPreference"];
  "startup.set": StartupService["setPreference"];

  /** Run para onde o ultimo clique de notificacao mandou, ou nulo. */
  "window.inboxTarget": () => string | null;
}

export type LocumApi = { [K in keyof ServiceApi]: Asyncify<ServiceApi[K]> };

/**
 * Os canais registrados, em ordem.
 *
 * A lista e escrita a mao porque o preload precisa dela em tempo de execucao e
 * tipo nao sobrevive ao build. O `setupBridge` confere que ela cobre a `LocumApi`
 * inteira e estoura na subida se alguem acrescentar um canal so de um lado.
 */
export const BRIDGE_CHANNELS = [
  "agents.list",
  "agents.get",
  "agents.versions",
  "runs.list",
  "runs.get",
  "runs.findings",
  "runs.rerunStep",
  "approvals.listPending",
  "approvals.get",
  "approvals.decide",
  "mcp.list",
  "mcp.test",
  "mcp.tools",
  "providers.list",
  "providers.fallbacks",
  "providers.preview",
  "metrics.report",
  "machine.profile",
  "triggers.list",
  "triggers.setEnabled",
  "startup.get",
  "startup.set",
  "window.inboxTarget",
] as const satisfies readonly (keyof LocumApi)[];

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[number];

type GroupOf<K extends string> = K extends `${infer G}.${string}` ? G : never;
type MemberOf<G extends string, K extends string> = K extends `${G}.${infer M}` ? M : never;

/** A mesma API, agrupada por prefixo, que e como a janela enxerga. */
export type LocumBridge = {
  [G in GroupOf<BridgeChannel>]: {
    [M in MemberOf<G, BridgeChannel>]: LocumApi[`${G}.${M}` & BridgeChannel];
  };
};

/** O nome sob o qual o preload pendura a ponte na janela. */
export const BRIDGE_GLOBAL = "locum";

declare global {
  interface Window {
    locum: LocumBridge;
  }
}
