import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs } from "../src/runtimes/claude-code.js";
import type { McpServerConfig } from "../src/config/types.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";

const pedido = (extra: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
  provider: "claude-code",
  model: "claude-sonnet-5",
  prompt: "triagem",
  tools: {},
  maxSteps: 4,
  ...extra,
});

const fixture = new Map<string, McpServerConfig>([
  ["locum-fixture", { name: "locum-fixture", transport: "stdio", command: ["npx", "tsx", "fixture.ts"] } as McpServerConfig],
]);

const valorDe = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

test("passo sem servidor não herda os servidores MCP da máquina", () => {
  const args = claudeArgs(pedido(), fixture);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.includes("--mcp-config"), false);
});

test("passo com servidor usa só os servidores do passo", () => {
  const args = claudeArgs(pedido({ mcpServers: ["locum-fixture"] }), fixture);
  assert.ok(args.includes("--strict-mcp-config"));
  const config = JSON.parse(valorDe(args, "--mcp-config") ?? "{}") as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(config.mcpServers), ["locum-fixture"]);
});

test("nenhuma fonte de configuração pessoal é carregada", () => {
  // Vazio tira usuário, projeto e local: sem hooks, regras e plugins da máquina.
  assert.equal(valorDe(claudeArgs(pedido(), fixture), "--setting-sources"), "");
});

test("execução não grava sessão no histórico pessoal", () => {
  assert.ok(claudeArgs(pedido(), fixture).includes("--no-session-persistence"));
});

test("não usa --bare, que derruba o login de assinatura", () => {
  assert.equal(claudeArgs(pedido(), fixture).includes("--bare"), false);
});
