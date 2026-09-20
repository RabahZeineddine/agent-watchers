import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServerConfig } from "../config/types.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

const run = promisify(execFile);

/**
 * Unica via que gasta a cota da assinatura Max.
 *
 * Nao passa `--bare`: esse modo ignora o login de assinatura e exige
 * ANTHROPIC_API_KEY, que e justamente o que queremos evitar aqui. O preco e que
 * o processo carrega a configuracao pessoal do usuario, incluindo hooks de
 * sessao que mudam o estilo da saida. A protecao e `--json-schema`, que torna a
 * saida estruturada independente de estilo.
 */
export class ClaudeCodeRuntime implements Runtime {
  readonly id = "claude-code";

  constructor(private mcpConfigs: Map<string, McpServerConfig>) {}

  private mcpConfigJson(servers: string[]): string {
    const out: Record<string, unknown> = {};
    for (const name of servers) {
      const cfg = this.mcpConfigs.get(name);
      if (!cfg) continue;
      out[name] =
        cfg.transport === "stdio"
          ? { command: cfg.command![0], args: cfg.command!.slice(1), env: cfg.env ?? {} }
          : { type: cfg.transport, url: cfg.url, headers: cfg.headers ?? {} };
    }
    return JSON.stringify({ mcpServers: out });
  }

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const servers = req.mcpServers ?? [];
    const allowed = Object.keys(req.tools).map((key) => {
      const [server, ...rest] = key.split("__");
      return `mcp__${server}__${rest.join("__")}`;
    });

    const args = ["-p", req.prompt, "--model", req.model, "--output-format", "json"];

    if (req.system) args.push("--append-system-prompt", req.system);
    if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema));
    if (servers.length > 0) args.push("--mcp-config", this.mcpConfigJson(servers));
    if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
    args.push("--permission-prompts", "none");

    const { stdout } = await run("claude", args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    const payload = JSON.parse(stdout) as {
      result?: string;
      structured_output?: unknown;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      is_error?: boolean;
    };

    if (payload.is_error) throw new Error(`claude -p falhou: ${payload.result ?? "sem detalhe"}`);

    return {
      text: payload.result ?? "",
      structured: payload.structured_output,
      promptTokens: payload.usage?.input_tokens ?? 0,
      completionTokens: payload.usage?.output_tokens ?? 0,
      // total_cost_usd e o equivalente em API. Na assinatura o gasto marginal
      // e cota, nao dinheiro, entao nao entra no orcamento em dolar.
      costUsd: payload.total_cost_usd ?? 0,
      billable: false,
      toolsUsed: [],
    };
  }
}
