import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { McpServerConfig, ToolRef } from "../config/types.js";

type Entry = {
  client: Awaited<ReturnType<typeof createMCPClient>>;
  tools: ToolSet;
  timer: NodeJS.Timeout | null;
  refs: number;
};

/**
 * Sobe servidor MCP sob demanda e encerra depois de ocioso.
 *
 * Cada servidor stdio e um processo de 30 a 80 MB. Sem isso, a quantidade de
 * servidores cadastrados vira o consumo de memoria em repouso do app, que e
 * exatamente o que nao pode acontecer num app que fica na bandeja o dia todo.
 */
export class McpRegistry {
  private live = new Map<string, Entry>();

  constructor(private configs: Map<string, McpServerConfig>) {}

  static fromList(list: McpServerConfig[]): McpRegistry {
    return new McpRegistry(new Map(list.map((c) => [c.name, c])));
  }

  has(name: string): boolean {
    return this.configs.has(name);
  }

  private async connect(name: string): Promise<Entry> {
    const existing = this.live.get(name);
    if (existing) return existing;

    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`servidor MCP "${name}" nao cadastrado`);

    const client =
      cfg.transport === "stdio"
        ? await createMCPClient({
            transport: new Experimental_StdioMCPTransport({
              command: cfg.command![0]!,
              args: cfg.command!.slice(1),
              env: cfg.env,
            }),
          })
        : await createMCPClient({
            transport: { type: cfg.transport, url: cfg.url!, headers: cfg.headers },
          });

    const entry: Entry = { client, tools: await client.tools(), timer: null, refs: 0 };
    this.live.set(name, entry);
    return entry;
  }

  private scheduleIdleClose(name: string): void {
    const entry = this.live.get(name);
    if (!entry || entry.refs > 0) return;
    const cfg = this.configs.get(name)!;
    entry.timer = setTimeout(() => {
      if (entry.refs === 0) {
        void entry.client.close();
        this.live.delete(name);
      }
    }, cfg.idleTimeoutMs);
    entry.timer.unref();
  }

  /**
   * Devolve apenas as ferramentas marcadas no passo. Habilitar o servidor
   * inteiro joga dezenas de schemas no contexto a cada chamada, o que custa
   * token e piora a escolha do modelo.
   */
  async toolsFor(refs: ToolRef[]): Promise<{ tools: ToolSet; release: () => void }> {
    const wanted = new Map<string, ToolRef[]>();
    for (const ref of refs) {
      if (ref.class === "external_write") {
        throw new Error(
          `ferramenta "${ref.server}.${ref.tool}" e escrita externa e nao pode entrar como tool de passo. ` +
            `Escrita externa vira passo de acao, que passa pela fila de aprovacao.`,
        );
      }
      const list = wanted.get(ref.server) ?? [];
      list.push(ref);
      wanted.set(ref.server, list);
    }

    const taken: string[] = [];
    const tools: ToolSet = {};

    for (const [server, list] of wanted) {
      const entry = await this.connect(server);
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.refs += 1;
      taken.push(server);

      for (const ref of list) {
        const found = entry.tools[ref.tool];
        if (!found) throw new Error(`ferramenta "${ref.tool}" nao existe no servidor "${server}"`);
        tools[`${server}__${ref.tool}`] = found;
      }
    }

    return {
      tools,
      release: () => {
        for (const server of taken) {
          const entry = this.live.get(server);
          if (!entry) continue;
          entry.refs = Math.max(0, entry.refs - 1);
          this.scheduleIdleClose(server);
        }
      },
    };
  }

  /** Servidores obrigatorios do passo que nao existem nesta maquina. */
  missing(names: string[]): string[] {
    return names.filter((n) => !this.configs.has(n));
  }

  async closeAll(): Promise<void> {
    for (const [name, entry] of this.live) {
      if (entry.timer) clearTimeout(entry.timer);
      await entry.client.close();
      this.live.delete(name);
    }
  }
}
