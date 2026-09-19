import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

/* ---------------------------------------------------------------- agents */

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * Versao imutavel. Toda gravacao na UI cria uma linha nova, e todo run aponta
 * para a versao exata que executou. E o que permite abrir um run antigo e ver
 * o pipeline como ele era.
 */
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    version: integer("version").notNull(),
    /** AgentSpec serializado. Validado por zod na leitura. */
    spec: text("spec", { mode: "json" }).notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("agent_versions_unq").on(t.agentId, t.version)],
);

export const triggers = sqliteTable("triggers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  /** schedule | webhook | poll | mcp-poll */
  kind: text("kind").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

/* ---------------------------------------------------------------- eventos */

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    /** Chave de deduplicacao vinda da origem. Ex: pr:482:sha:abc123 */
    externalId: text("external_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    receivedAt: integer("received_at").notNull().default(now),
  },
  (t) => [uniqueIndex("events_external_unq").on(t.source, t.externalId)],
);

/**
 * Janela de varredura por fonte. Cursor, nunca intervalo: intervalo morre
 * quando o Mac dorme e a janela e perdida.
 */
export const cursors = sqliteTable(
  "cursors",
  {
    source: text("source").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("cursors_unq").on(t.source, t.key)],
);

/* --------------------------------------------------------------- execucao */

/** queued | running | paused | done | failed | cancelled */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
    triggerId: text("trigger_id"),
    eventId: text("event_id").references(() => events.id),
    status: text("status").notNull().default("queued"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    /** Dinheiro de verdade. Passo em assinatura nao entra aqui. */
    costUsd: real("cost_usd").notNull().default(0),
    /** Inclui o equivalente estimado do que rodou na assinatura. */
    estimateUsd: real("estimate_usd").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("runs_status_idx").on(t.status)],
);

/** pending | running | done | failed | skipped | awaiting_approval */
export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    stepKey: text("step_key").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    modelRequested: text("model_requested"),
    modelUsed: text("model_used"),
    substitutionReason: text("substitution_reason"),
    /** [{ nome, origem, hash }]. Sem o hash a metrica mente. */
    skillsUsed: text("skills_used", { mode: "json" }),
    toolsUsed: text("tools_used", { mode: "json" }),
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    /** false quando rodou na assinatura: consome cota, nao dinheiro. */
    billable: integer("billable", { mode: "boolean" }).notNull().default(true),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("steps_run_key_unq").on(t.runId, t.stepKey)],
);

/* -------------------------------------------------------------- aprovacao */

/** pending | approved | rejected | expired | auto */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    stepId: text("step_id").notNull().references(() => steps.id),
    /** github.review_comment | slack.post | jira.create ... */
    kind: text("kind").notNull(),
    /** Exatamente o que sairia se aprovado. */
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"),
    /**
     * Gravado antes de chamar a API externa. Retry depois de crash nao
     * comenta duas vezes.
     */
    externalId: text("external_id"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("approvals_status_idx").on(t.status)],
);

/* ------------------------------------------------ achados e aprendizagem */

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    /** critical | high | medium | low */
    severity: text("severity").notNull(),
    category: text("category"),
    file: text("file"),
    line: integer("line"),
    body: text("body").notNull(),
    /** open | posted | dismissed */
    state: text("state").notNull().default("open"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("findings_run_idx").on(t.runId)],
);

/**
 * Preenchido pelo reconciliador quando o PR fecha. E o gabarito: o que
 * humano confirmou, o que virou commit, o que ninguem olhou.
 */
export const findingOutcomes = sqliteTable("finding_outcomes", {
  id: text("id").primaryKey(),
  findingId: text("finding_id").notNull().references(() => findings.id),
  /** confirmed_by_human | became_commit | ignored | disputed | duplicate */
  state: text("state").notNull(),
  evidence: text("evidence", { mode: "json" }),
  detectedAt: integer("detected_at").notNull().default(now),
});

/** O que revisores humanos disseram. Serve de gabarito e de corpus. */
export const reviewSignals = sqliteTable(
  "review_signals",
  {
    id: text("id").primaryKey(),
    prKey: text("pr_key").notNull(),
    author: text("author").notNull(),
    /** comment | change_request | suggestion */
    kind: text("kind").notNull(),
    file: text("file"),
    line: integer("line"),
    body: text("body").notNull(),
    becameCommit: integer("became_commit", { mode: "boolean" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("review_signals_pr_idx").on(t.prKey)],
);

export const agentMetrics = sqliteTable("agent_metrics", {
  id: text("id").primaryKey(),
  agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
  /** Conjunto de skills junto da versao, senao a comparacao mente. */
  skillSet: text("skill_set", { mode: "json" }),
  windowStart: integer("window_start").notNull(),
  windowEnd: integer("window_end").notNull(),
  findingCount: integer("finding_count").notNull().default(0),
  precision: real("precision"),
  agreement: real("agreement"),
  missed: integer("missed").notNull().default(0),
});

/* --------------------------------------------- provedores, mcp, orcamento */

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  /** anthropic | openai | google | openai-compatible | claude-code */
  kind: text("kind").notNull(),
  baseUrl: text("base_url"),
  /** Chave no keychain, nunca o segredo. */
  credentialRef: text("credential_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

/** Local da maquina. Nao vai para o git. */
export const modelFallbacks = sqliteTable(
  "model_fallbacks",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull(),
    fromModel: text("from_model").notNull(),
    toModel: text("to_model").notNull(),
    order: integer("order").notNull().default(0),
  },
  (t) => [index("model_fallbacks_machine_idx").on(t.machineId, t.fromModel)],
);

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** stdio | http | sse */
  transport: text("transport").notNull(),
  command: text("command", { mode: "json" }),
  url: text("url"),
  headers: text("headers", { mode: "json" }),
  credentialRef: text("credential_ref"),
  /** read | write. Cloud entra como read, configurado tambem na origem. */
  scope: text("scope").notNull().default("read"),
  idleTimeoutMs: integer("idle_timeout_ms").notNull().default(300_000),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const budgets = sqliteTable("budgets", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id),
  perRunUsd: real("per_run_usd"),
  perDayUsd: real("per_day_usd"),
});

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    day: text("day").notNull(),
    agentId: text("agent_id").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    runs: integer("runs").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_daily_unq").on(t.day, t.agentId)],
);
