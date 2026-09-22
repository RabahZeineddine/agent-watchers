import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as esperar } from "node:timers/promises";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec, McpServerConfig } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";

const SERVIDOR = fileURLToPath(new URL("../src/fixtures/mcp-fixture-server.ts", import.meta.url));

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

/**
 * Espera até a condição valer, ou estoura.
 *
 * Espera fixa aposta na velocidade da máquina: subir e derrubar processo pelo
 * `npx tsx` passa de 500 ms quando a máquina está carregada, e o teste caía
 * rodando logo depois do teste de fumaça do Electron. Aqui o teste termina assim
 * que a condição vale, e o prazo só existe para não travar para sempre.
 */
async function ateQue(condicao: () => boolean, mensagem: string, prazoMs = 15_000): Promise<void> {
  const limite = Date.now() + prazoMs;
  while (!condicao()) {
    if (Date.now() > limite) assert.fail(mensagem);
    await esperar(50);
  }
}

function brinquedo(idleTimeoutMs: number, extra: Record<string, string> = {}): McpServerConfig {
  return McpServerConfig.parse({
    name: "brinquedo",
    transport: "stdio",
    command: [process.execPath, "--import", "tsx", SERVIDOR],
    env: { PATH: process.env.PATH ?? "", ...extra },
    idleTimeoutMs,
  });
}

const vivos: McpRegistry[] = [];
after(async () => {
  for (const registro of vivos) await registro.closeAll();
});

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runtime que só chama a ferramenta `pid` e guarda quem respondeu. */
function runtimeQuePergunta(pids: number[]): Runtime {
  return {
    id: "native",
    run: async (req) => {
      const ferramenta = req.tools?.["brinquedo__pid"];
      assert.ok(ferramenta?.execute, "o passo deveria receber a ferramenta pid");
      const resposta = (await ferramenta.execute({}, { toolCallId: randomUUID(), messages: [] })) as {
        content: { text: string }[];
      };
      pids.push(Number(resposta.content[0]!.text));
      return { text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] };
    },
  };
}

async function versaoComFerramenta(): Promise<string> {
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `pool-${randomUUID()}`,
      name: "Pool",
      steps: [
        {
          type: "model",
          key: "perguntar",
          name: "Perguntar",
          model: "ollama/modelo",
          prompt: "pergunte o pid",
          tools: [{ server: "brinquedo", tool: "pid" }],
        },
      ],
    }),
    undefined,
    "human",
  );
  return versao.id;
}

test("duas execuções seguidas reaproveitam o processo, que fecha depois do ócio", async () => {
  const registro = new McpRegistry(new Map([["brinquedo", brinquedo(1_500)]]));
  vivos.push(registro);
  const pids: number[] = [];
  const executor = new Executor({
    mcp: registro,
    runtimes: new Map([["native", runtimeQuePergunta(pids)]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });
  const versao = await versaoComFerramenta();

  assert.equal(await executor.execute(await executor.createRun(versao, null)), "done");
  assert.equal(await executor.execute(await executor.createRun(versao, null)), "done");

  assert.equal(pids.length, 2);
  assert.equal(pids[0], pids[1], "a segunda execução subiu outro processo");
  assert.ok(vivo(pids[0]!), "o processo deveria continuar de pé entre execuções");

  await ateQue(() => !vivo(pids[0]!), "o processo deveria ter fechado depois do tempo ocioso");
});

test("recadastro igual mantém o processo, e cadastro trocado sobe outro", async () => {
  const registro = new McpRegistry(new Map([["brinquedo", brinquedo(60_000)]]));
  vivos.push(registro);
  const pid = async () => Number(((await registro.callTool("brinquedo", "pid")) as { content: { text: string }[] }).content[0]!.text);

  const primeiro = await pid();
  registro.reconfigure(new Map([["brinquedo", brinquedo(60_000)]]));
  assert.equal(await pid(), primeiro);

  registro.reconfigure(new Map([["brinquedo", brinquedo(60_000, { MARCA: "outra" })]]));
  const segundo = await pid();
  assert.notEqual(segundo, primeiro);
  await ateQue(() => !vivo(primeiro), "o processo do cadastro antigo deveria ter fechado");

  registro.reconfigure(new Map());
  await ateQue(() => !vivo(segundo), "servidor que saiu do cadastro deveria ter fechado");
});
