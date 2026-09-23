import { test } from "node:test";
import assert from "node:assert/strict";
import { fromJSONSchema } from "zod";
import { ReviewFinding } from "../src/config/types.js";
import { renderPrompt } from "../src/executor/executor.js";
import { demoCleanPr, demoPr } from "../src/examples/demo-event.js";
import { prReviewSpec } from "../src/examples/agents.js";
import { parseTarget } from "../src/services/execution-service.js";

function auditoria() {
  const p = prReviewSpec.steps.find((s) => s.key === "audit");
  assert.ok(p?.type === "model");
  return p;
}

const achado = {
  file: "src/Pedido.cs",
  line: 10,
  severity: "high",
  confidence: "high",
  problem: "referência nula quando o pedido não tem cliente",
};

test("todo achado da auditoria traz confiança, validada pelo esquema de saída", () => {
  const esquema = fromJSONSchema(auditoria().outputSchema as never);

  const verdict = "COMMENT";
  assert.equal(esquema.safeParse({ findings: [achado], verdict }).success, true);
  assert.equal(esquema.safeParse({ findings: [], verdict }).success, true, "lista vazia é resposta válida");

  const { confidence: _c, ...semConfianca } = achado;
  assert.equal(esquema.safeParse({ findings: [semConfianca], verdict }).success, false, "sem confiança");
  assert.equal(
    esquema.safeParse({ findings: [{ ...achado, confidence: "certeza" }], verdict }).success,
    false,
  );
});

test("a confiança atravessa a edição pela janela, que é estrita", () => {
  assert.equal(ReviewFinding.safeParse(achado).success, true);
  assert.equal(ReviewFinding.safeParse({ ...achado, confidence: "talvez" }).success, false);

  // Pendência gravada antes do campo existir continua editável.
  const { confidence: _c, ...antigo } = achado;
  assert.equal(ReviewFinding.safeParse(antigo).success, true);
});

test("o prompt da auditoria traz os seis focos, a rubrica e a intenção do pull request", () => {
  const evento = { ...demoPr, omittedSummary: "package-lock.json (lockfile)" };
  const prompt = renderPrompt(auditoria().prompt, evento, new Map([["triage", { category: "fix" }]]));

  for (const foco of [
    /regressão funcional/i,
    /idempot/i,
    /concorrência/i,
    /autorização/i,
    /erro engolido/i,
    /contrato/i,
    /teste/i,
  ]) {
    assert.match(prompt, foco);
  }
  for (const nivel of ["critical", "high", "medium", "low"]) assert.match(prompt, new RegExp(`- ${nivel}:`));

  assert.match(prompt, new RegExp(`Título: ${demoPr.title}\n`));
  assert.match(prompt, new RegExp(`Descrição: ${demoPr.description}\n`));
  assert.match(prompt, /package-lock\.json \(lockfile\)/);
  assert.match(prompt, /confidence/);
  assert.doesNotMatch(prompt, /\{\{/, "nenhum marcador sobrou sem troca");
});

test("o evento limpo é outro pull request e tem alvo próprio", () => {
  assert.deepEqual(parseTarget("sintetico-limpo"), { kind: "synthetic", variant: "clean" });
  assert.deepEqual(parseTarget("sintetico"), { kind: "synthetic" });

  assert.notEqual(demoCleanPr.pull, demoPr.pull);
  assert.notEqual(demoCleanPr.diff, demoPr.diff);
  assert.deepEqual(demoCleanPr.omittedFiles, []);
});
