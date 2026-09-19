#!/usr/bin/env node
/**
 * Servidor MCP de brinquedo, por transporte stdio.
 *
 * Existe para que `McpService.testConnection` e `listTools` tenham como ser
 * verificados sem depender de nada instalado na máquina. Loop de execução que
 * depende de servidor externo trava na primeira máquina que não tem o servidor.
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

await server.connect(new StdioServerTransport());
