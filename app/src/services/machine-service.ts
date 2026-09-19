import { desc } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { dbPath } from "../db/path.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { providerService, type ProviderInfo, type ProviderService } from "./provider-service.js";
import type { FallbackRow } from "../providers/registry.js";

type Db = typeof defaultDb;

/**
 * Identidade local. A tabela de substituicao, o que roda aqui e o perfil todo
 * dependem dela, entao mora no servico em vez de na montagem do executor: quem
 * pergunta "onde eu estou" nao deveria precisar carregar o executor junto.
 */
export const machineId = process.env.MACHINE_ID ?? "default";

/** Servidor MCP como ele aparece no perfil, sem comando nem cabecalho. */
export interface MachineMcpServer {
  name: string;
  transport: string;
  scope: string;
  enabled: boolean;
}

/** Retrato desta maquina: o que roda, para onde cai e onde o banco esta. */
export interface MachineProfile {
  machineId: string;
  dbPath: string;
  providers: ProviderInfo[];
  fallbacks: FallbackRow[];
  mcpServers: MachineMcpServer[];
  lastRunAt: number | null;
}

/**
 * O retrato da maquina. Linha de comando, servidor MCP e interface passam por
 * aqui porque as tres perguntam a mesma coisa antes de disparar qualquer run:
 * o que esta disponivel neste computador.
 */
export class MachineService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly providers: ProviderService = providerService,
    private readonly mcp: McpService = mcpService,
  ) {}

  async profile(): Promise<MachineProfile> {
    const [lastRun] = await this.db
      .select({ createdAt: schema.runs.createdAt })
      .from(schema.runs)
      .orderBy(desc(schema.runs.createdAt))
      .limit(1);

    return {
      machineId,
      dbPath: dbPath(),
      providers: this.providers.listProviders(),
      fallbacks: await this.providers.getFallbacks(machineId),
      mcpServers: (await this.mcp.list()).map(({ config, enabled }) => ({
        name: config.name,
        transport: config.transport,
        scope: config.scope,
        enabled,
      })),
      lastRunAt: lastRun?.createdAt ?? null,
    };
  }
}

export const machineService = new MachineService();
