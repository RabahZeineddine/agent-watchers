#!/usr/bin/env node
/**
 * Entrada do servidor MCP do Locum, por transporte stdio.
 *
 * O banco e o mesmo do aplicativo. O modo WAL deixa este processo ler enquanto
 * a linha de comando escreve, entao nao existe copia nem sincronizacao.
 *
 * Nada pode escrever em stdout aqui: stdout e o canal do protocolo, e um
 * `console.log` perdido corrompe a sessao do cliente. Diagnostico vai para
 * stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";

const server = buildMcpServer();
await server.connect(new StdioServerTransport());
console.error("servidor MCP do locum no ar");
