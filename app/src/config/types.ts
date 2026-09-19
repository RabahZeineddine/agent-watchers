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

export const AgentSpec = z.object({
  id: z.string(),
  name: z.string(),
  /** Herdadas por todo passo `model` que nao declarar as suas. */
  defaultTools: z.array(ToolRef).default([]),
  skills: z.array(SkillRule).default([]),
  steps: z.array(Step).min(1),
  budget: z
    .object({ perRunUsd: z.number().positive().optional(), perDayUsd: z.number().positive().optional() })
    .default({}),
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
