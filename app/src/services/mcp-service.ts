import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { McpServerConfig, type McpServerInput } from "../config/types.js";

type Db = typeof defaultDb;

export type McpServerRow = typeof schema.mcpServers.$inferSelect;

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
