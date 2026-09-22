import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  compactarHistorico,
  TETO_DO_HISTORICO,
  TROCAS_INTEIRAS,
} from "../src/services/chat-history.js";

/** Uma troca como o SDK devolve: pergunta, chamada de ferramenta, resultado grande, resposta. */
function troca(n: number, tamanhoDoResultado = 20_000): ModelMessage[] {
  return [
    { role: "user", content: `pergunta ${n}` },
    {
      role: "assistant",
      content: [
        { type: "text", text: `vou olhar ${n}` },
        { type: "tool-call", toolCallId: `c${n}`, toolName: "list_runs", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${n}`,
          toolName: "list_runs",
          output: { type: "text", value: "x".repeat(tamanhoDoResultado) },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: `resposta ${n}` }] },
  ];
}

const tamanho = (m: ModelMessage[]) => JSON.stringify(m).length;

test("conversa longa fica abaixo do teto", () => {
  let historico: ModelMessage[] = [];
  for (let n = 0; n < 200; n++) {
    historico.push(...troca(n));
    historico = compactarHistorico(historico).mensagens;
    assert.ok(tamanho(historico) <= TETO_DO_HISTORICO, `troca ${n}: ${tamanho(historico)}`);
  }
});

test("as últimas trocas seguem inteiras e as anteriores só com o texto", () => {
  const historico = Array.from({ length: 8 }, (_, n) => troca(n, 100)).flat();
  const { mensagens, resumido } = compactarHistorico(historico);

  assert.equal(resumido, true);
  const recentes = Array.from({ length: TROCAS_INTEIRAS }, (_, i) => troca(8 - TROCAS_INTEIRAS + i, 100)).flat();
  assert.deepEqual(mensagens.slice(-recentes.length), recentes);

  const antigas = mensagens.slice(0, -recentes.length);
  assert.ok(antigas.every((m) => m.role !== "tool"));
  assert.ok(
    antigas.every(
      (m) => typeof m.content === "string" || m.content.every((p) => p.type === "text"),
    ),
  );
  assert.deepEqual(antigas.slice(0, 3), [
    { role: "user", content: "pergunta 0" },
    { role: "assistant", content: [{ type: "text", text: "vou olhar 0" }] },
    { role: "assistant", content: [{ type: "text", text: "resposta 0" }] },
  ]);
});

test("conversa curta passa sem mexer e não se diz resumida", () => {
  const historico = [troca(0), troca(1)].flat();
  const { mensagens, resumido } = compactarHistorico(historico);
  assert.equal(resumido, false);
  assert.deepEqual(mensagens, historico);
});

test("a primeira mensagem enviada é sempre do usuário", () => {
  let historico: ModelMessage[] = [];
  for (let n = 0; n < 50; n++) {
    historico.push(...troca(n, 60_000));
    historico = compactarHistorico(historico).mensagens;
    assert.equal(historico[0]?.role, "user");
  }
});
