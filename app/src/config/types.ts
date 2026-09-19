import { z } from "zod";

/**
 * Classe da ferramenta. `external_write` e o unico valor que forca aprovacao,
 * e isso nao e configuravel por heranca nem por agent.
 */
export const ToolClass = z.enum(["read", "internal_write", "external_write"]);
export type ToolClass = z.infer<typeof ToolClass>;

export const ToolRef = z.object({
  server: z.string(),
  tool: z.string(),
  class: ToolClass.default("read"),
});
export type ToolRef = z.infer<typeof ToolRef>;

/** Regra deterministica de skill, casada com os arquivos alterados no evento. */
export const SkillRule = z.object({
  skill: z.string(),
  when: z
    .object({
      always: z.boolean().optional(),
      filesMatch: z.array(z.string()).optional(),
      repoMatch: z.array(z.string()).optional(),
    })
    .default({ always: true }),
});
export type SkillRule = z.infer<typeof SkillRule>;

/** Modo de uma acao de escrita externa. Nasce em `approve`. */
export const ActionMode = z.enum(["approve", "draft", "auto"]);
export type ActionMode = z.infer<typeof ActionMode>;

const StepBase = z.object({
  key: z.string(),
  name: z.string(),
  /**
   * Dependencias. O editor da v1 e uma lista, mas o modelo de dados ja e um
   * grafo, para que ramificacao e canvas entrem depois sem migracao.
   */
  needs: z.array(z.string()).default([]),
  optional: z.boolean().default(false),
});

export const ModelStep = StepBase.extend({
  type: z.literal("model"),
  /** Modelo concreto, ex: "anthropic/claude-opus-5". Fallback e por maquina. */
  model: z.string(),
  prompt: z.string(),
  /** Ausente herda as ferramentas padrao do agent. */
  tools: z.array(ToolRef).optional(),
  /** Servidores MCP obrigatorios. Faltou, o passo falha limpo. */
  requiresServers: z.array(z.string()).default([]),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  maxSteps: z.number().int().positive().default(12),
});

export const ActionStep = StepBase.extend({
  type: z.literal("action"),
  /** github.review_comment | slack.post | jira.create */
  action: z.string(),
  mode: ActionMode.default("approve"),
  input: z.string().optional(),
});

export const Step = z.discriminatedUnion("type", [ModelStep, ActionStep]);
export type Step = z.infer<typeof Step>;
export type ModelStep = z.infer<typeof ModelStep>;
export type ActionStep = z.infer<typeof ActionStep>;

/**
 * Teto de gasto do agent. Teto ausente e sem teto, nao teto zero, e por isso
 * os dois campos sao opcionais em vez de terem default numerico.
 */
export const AgentBudget = z.object({
  perRunUsd: z.number().positive().optional(),
  perDayUsd: z.number().positive().optional(),
});
export type AgentBudget = z.infer<typeof AgentBudget>;

/**
 * Alteracao parcial de orcamento. `null` apaga o teto e ausente deixa como
 * esta, porque quem edita um teto so costuma mandar o campo que mexeu, e sem
 * essa distincao nao haveria como voltar para sem teto.
 */
export const AgentBudgetPatch = z.object({
  perRunUsd: z.number().positive().nullable().optional(),
  perDayUsd: z.number().positive().nullable().optional(),
});
export type AgentBudgetPatch = z.infer<typeof AgentBudgetPatch>;

export const AgentSpec = z.object({
  id: z.string(),
  name: z.string(),
  /** Herdadas por todo passo `model` que nao declarar as suas. */
  defaultTools: z.array(ToolRef).default([]),
  skills: z.array(SkillRule).default([]),
  steps: z.array(Step).min(1),
  budget: AgentBudget.default({}),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

/** Ferramentas efetivas do passo, ja aplicada a heranca. */
export function resolveTools(spec: AgentSpec, step: ModelStep): ToolRef[] {
  return step.tools ?? spec.defaultTools;
}

/** Ordem topologica. Lanca em ciclo, porque ciclo aqui e bug de autoria. */
export function topoSort(steps: Step[]): Step[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const state = new Map<string, "visiting" | "done">();
  const out: Step[] = [];

  const visit = (key: string, trail: string[]): void => {
    const st = state.get(key);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`ciclo entre passos: ${[...trail, key].join(" -> ")}`);
    const step = byKey.get(key);
    if (!step) throw new Error(`passo "${key}" depende de um passo inexistente`);
    state.set(key, "visiting");
    for (const dep of step.needs) visit(dep, [...trail, key]);
    state.set(key, "done");
    out.push(step);
  };

  for (const s of steps) visit(s.key, []);
  return out;
}

/** Transporte do servidor MCP. `stdio` sobe processo, os outros falam por rede. */
export const McpTransport = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransport>;

/**
 * Cadastro de um servidor MCP. Mora aqui, e nao no registro, porque a mesma
 * validacao vale para a linha de comando, para o servidor MCP proprio e para a
 * tela de configuracao.
 */
export const McpServerConfig = z
  .object({
    name: z.string().min(1),
    transport: McpTransport,
    /** Executavel e argumentos, ja separados. So para `stdio`. */
    command: z.array(z.string().min(1)).min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /**
     * `write` nao libera escrita externa sem aprovacao: a fila continua valendo.
     * Serve para separar o que so le do que muda estado em algum lugar.
     */
    scope: z.enum(["read", "write"]).default("read"),
    idleTimeoutMs: z.number().int().positive().default(300_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.transport === "stdio" && !cfg.command) {
      ctx.addIssue({ code: "custom", message: "transporte stdio exige command", path: ["command"] });
    }
    if (cfg.transport !== "stdio" && !cfg.url) {
      ctx.addIssue({ code: "custom", message: `transporte ${cfg.transport} exige url`, path: ["url"] });
    }
  });
export type McpServerConfig = z.infer<typeof McpServerConfig>;
/** O que se passa para cadastrar, antes dos defaults do zod. */
export type McpServerInput = z.input<typeof McpServerConfig>;

/* --------------------------------------------------------------- gatilhos */

/**
 * Configuracao de um gatilho, por tipo.
 *
 * O tipo aparece dentro da configuracao e tambem numa coluna propria da
 * tabela. A repeticao e de proposito: a coluna e o que permite filtrar sem
 * abrir o JSON, e o campo interno e o que discrimina a uniao aqui. O servico
 * grava a coluna a partir do valor ja validado, entao os dois nao divergem.
 *
 * `everyMinutes` e cadencia desejada, nao promessa de pontualidade. Quem
 * executa e o agendador do N.3, que anda por cursor porque o Mac dorme e uma
 * janela fixa perderia o intervalo inteiro.
 */
export const ScheduleTrigger = z.object({
  kind: z.literal("schedule"),
  everyMinutes: z.number().int().min(1),
});

export const WebhookTrigger = z.object({
  kind: z.literal("webhook"),
  /** Caminho local que recebe a chamada. Segredo do emissor mora no keychain. */
  path: z.string().min(1),
});

export const PollTrigger = z.object({
  kind: z.literal("poll"),
  /** Fonte cadastrada, hoje so `github`. */
  source: z.string().min(1),
  /** Expressao aplicada ao nome do repositorio, como no comando `poll`. */
  repoMatch: z.string().min(1),
  everyMinutes: z.number().int().min(1).default(15),
});

export const McpPollTrigger = z.object({
  kind: z.literal("mcp-poll"),
  /** Servidor MCP cadastrado, no papel de cliente. */
  server: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  everyMinutes: z.number().int().min(1).default(15),
});

export const TriggerConfig = z.discriminatedUnion("kind", [
  ScheduleTrigger,
  WebhookTrigger,
  PollTrigger,
  McpPollTrigger,
]);
export type TriggerConfig = z.infer<typeof TriggerConfig>;
/** O que se passa para cadastrar, antes dos defaults do zod. */
export type TriggerConfigInput = z.input<typeof TriggerConfig>;
