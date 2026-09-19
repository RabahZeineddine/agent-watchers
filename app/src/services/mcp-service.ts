import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { McpRegistry, type McpToolInfo } from "../mcp/registry.js";
import { McpServerConfig, type McpServerInput } from "../config/types.js";

export type { McpToolInfo };

type Db = typeof defaultDb;

export type McpServerRow = typeof schema.mcpServers.$inferSelect;

/** Resultado de uma tentativa de conexao, para a tela e para a linha de comando. */
export interface McpConnectionCheck {
  name: string;
  ok: boolean;
  elapsedMs: number;
  toolCount: number;
  error?: string;
}

/** Cadastro somado ao que so interessa a quem administra, nao a quem conecta. */
export interface McpServerEntry {
  config: McpServerConfig;
  enabled: boolean;
  credentialRef: string | null;
}

/**
 * Cadastro de servidores MCP. Linha de comando, servidor MCP proprio e
 * interface passam por aqui, porque a validacao de transporte e a regra de
 * quem entra no executor precisam valer para os tres.
 */
export class McpService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(): Promise<McpServerEntry[]> {
    const rows = await this.db.select().from(schema.mcpServers);
    return rows.map(toEntry);
  }

  async get(name: string): Promise<McpServerEntry | undefined> {
    const row = await this.row(name);
    return row ? toEntry(row) : undefined;
  }

  /**
   * So o que o executor deve enxergar. Servidor desabilitado some do registro
   * em vez de virar erro de conexao no meio de um passo.
   */
  async enabledConfigs(): Promise<McpServerConfig[]> {
    const rows = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.enabled, true));
    return rows.map((row) => toEntry(row).config);
  }

  /** Cadastra ou atualiza pelo nome, que e a chave que o passo referencia. */
  async register(config: McpServerInput): Promise<McpServerEntry> {
    const parsed = McpServerConfig.parse(config);
    const values = {
      name: parsed.name,
      transport: parsed.transport,
      command: parsed.command ?? null,
      env: parsed.env ?? null,
      url: parsed.url ?? null,
      headers: parsed.headers ?? null,
      scope: parsed.scope,
      idleTimeoutMs: parsed.idleTimeoutMs,
    };

    await this.db
      .insert(schema.mcpServers)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({ target: schema.mcpServers.name, set: values });

    return toEntry((await this.row(parsed.name))!);
  }

  async remove(name: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.mcpServers)
      .where(eq(schema.mcpServers.name, name))
      .returning();
    return deleted.length > 0;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const updated = await this.db
      .update(schema.mcpServers)
      .set({ enabled })
      .where(eq(schema.mcpServers.name, name))
      .returning();
    if (updated.length === 0) throw new Error(`servidor MCP "${name}" nao cadastrado`);
  }

  /**
   * Sobe o servidor cadastrado e conta o que ele expoe.
   *
   * Nao lanca quando a conexao falha: falhar e um desfecho normal aqui, e quem
   * administra quer ver o motivo na tela, nao um erro subindo a pilha.
   * Servidor desabilitado tambem e testavel, porque o caminho natural e testar
   * antes de habilitar.
   */
  async testConnection(name: string): Promise<McpConnectionCheck> {
    const started = Date.now();
    try {
      const tools = await this.probe(name, (registry) => registry.describeTools(name));
      return { name, ok: true, elapsedMs: Date.now() - started, toolCount: tools.length };
    } catch (err) {
      return {
        name,
        ok: false,
        elapsedMs: Date.now() - started,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Catalogo de ferramentas do servidor, para escolher quais marcar num passo. */
  async listTools(name: string): Promise<McpToolInfo[]> {
    return this.probe(name, (registry) => registry.describeTools(name));
  }

  /**
   * Registro descartavel com um servidor so. O registro do executor fica vivo
   * enquanto o run dura, mas conferir cadastro e operacao avulsa: abre, olha e
   * fecha, sem deixar processo para tras.
   */
  private async probe<T>(name: string, fn: (registry: McpRegistry) => Promise<T>): Promise<T> {
    const entry = await this.get(name);
    if (!entry) throw new Error(`servidor MCP "${name}" nao cadastrado`);

    const registry = McpRegistry.fromList([entry.config]);
    try {
      return await fn(registry);
    } finally {
      await registry.closeAll();
    }
  }

  private async row(name: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.name, name));
    return row;
  }
}

/**
 * O banco guarda command, env e headers como JSON solto. A volta passa pelo
 * zod para que linha gravada por uma versao antiga do schema estoure aqui, no
 * cadastro, e nao la na frente na hora de subir o processo.
 */
function toEntry(row: McpServerRow): McpServerEntry {
  return {
    config: McpServerConfig.parse({
      name: row.name,
      transport: row.transport,
      command: row.command ?? undefined,
      env: row.env ?? undefined,
      url: row.url ?? undefined,
      headers: row.headers ?? undefined,
      scope: row.scope,
      idleTimeoutMs: row.idleTimeoutMs,
    }),
    enabled: row.enabled,
    credentialRef: row.credentialRef,
  };
}

export const mcpService = new McpService();
