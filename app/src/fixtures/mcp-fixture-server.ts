#!/usr/bin/env node
/**
 * Servidor MCP de brinquedo, por transporte stdio.
 *
 * Existe para que `McpService.testConnection` e `listTools` tenham como ser
 * verificados sem depender de nada instalado na máquina. Loop de execução que
 * depende de servidor externo trava na primeira máquina que não tem o servidor.
 *
 * O `feed` entrou depois, para a varredura por consulta a servidor MCP ter um
 * alvo que devolve lista carimbada no tempo em vez de valor solto.
 *
 * Não é parte do produto. Serve de alvo de teste e de exemplo mínimo de como
 * um servidor stdio se parece.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "locum-fixture", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    description: "Devolve o texto recebido, para conferir ida e volta.",
    inputSchema: { text: z.string().describe("texto a devolver") },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "sum",
  {
    description: "Soma dois números, para conferir entrada tipada.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

server.registerTool(
  "slow",
  {
    description: "Espera alguns milissegundos, para exercitar timeout.",
    inputSchema: { ms: z.number().int().min(0).max(10_000) },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: "text", text: `esperou ${ms}ms` }] };
  },
);

server.registerTool(
  "fail",
  {
    description: "Falha de propósito, para exercitar tratamento de erro.",
    inputSchema: { reason: z.string().default("falha proposital") },
  },
  async ({ reason }) => ({ content: [{ type: "text", text: reason }], isError: true }),
);

/**
 * Âncora do feed de brinquedo.
 *
 * Data fixa, e não `Date.now()`, porque a varredura por cursor só pode ser
 * verificada se as duas passadas virem os mesmos itens: carimbo relativo ao
 * relógio geraria identificador novo a cada subida do processo e a
 * deduplicação passaria sem nunca ter sido exercitada.
 */
const FEED_INICIO = Date.parse("2026-01-01T00:00:00.000Z");

server.registerTool(
  "feed",
  {
    description: "Devolve itens carimbados no tempo, para exercitar varredura por cursor.",
    inputSchema: {
      since: z
        .string()
        .default(new Date(0).toISOString())
        .describe("carimbo ISO; devolve item a partir dele, inclusive"),
      count: z.number().int().min(0).max(50).default(3).describe("quantos itens o feed tem"),
    },
  },
  async ({ since, count }) => {
    const corte = Date.parse(since);
    const items = Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      at: new Date(FEED_INICIO + i * 60_000).toISOString(),
      text: `item ${i} do feed de brinquedo`,
    }));

    // O corte é inclusive de propósito: o último item da passada anterior volta
    // na seguinte. É assim que a maioria dos feeds reais responde a um `since`,
    // e é o que obriga a deduplicação por chave externa a fazer o trabalho em
    // vez de o servidor esconder o problema filtrando com folga.
    const janela = Number.isNaN(corte)
      ? items
      : items.filter((item) => Date.parse(item.at) >= corte);

    return { content: [{ type: "text", text: JSON.stringify({ items: janela }) }] };
  },
);

await server.connect(new StdioServerTransport());
