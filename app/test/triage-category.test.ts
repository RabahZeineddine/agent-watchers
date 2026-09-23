import { test } from "node:test";
import assert from "node:assert/strict";
import { fromJSONSchema } from "zod";
import { renderPrompt } from "../src/executor/executor.js";
import { prReviewSpec } from "../src/examples/agents.js";

function passo(chave: string) {
  const p = prReviewSpec.steps.find((s) => s.key === chave);
  assert.ok(p?.type === "model", chave);
  return p;
}

const evento = { repo: "o/r", changedFiles: ["src/Api/Startup.cs"], diff: "diff", omittedSummary: "nenhum" };

const triagem = {
  category: "dependency",
  scope: "Atualização do Newtonsoft.Json de 12 para 13.",
  sensitive_files: [{ file: "src/Api/Startup.cs", area: "public_route" }],
  risk_areas: ["mudança de comportamento na desserialização"],
  files_to_read: ["src/Api/Startup.cs"],
};

test("a saída da triagem exige categoria e arquivos sensíveis, validados pelo esquema", () => {
  const esquema = fromJSONSchema(passo("triage").outputSchema as never);

  assert.equal(esquema.safeParse(triagem).success, true);

  const { category: _c, ...semCategoria } = triagem;
  assert.equal(esquema.safeParse(semCategoria).success, false, "sem categoria");
  const { sensitive_files: _s, ...semSensiveis } = triagem;
  assert.equal(esquema.safeParse(semSensiveis).success, false, "sem arquivos sensíveis");

  assert.equal(esquema.safeParse({ ...triagem, category: "hotfix" }).success, false, "categoria fora da lista");
  assert.equal(
    esquema.safeParse({ ...triagem, sensitive_files: [{ file: "a.cs", area: "estilo" }] }).success,
    false,
    "área sensível fora da lista",
  );

  for (const category of ["fix", "feature", "refactor", "config", "dependency"]) {
    assert.equal(esquema.safeParse({ ...triagem, category }).success, true, category);
  }
});

test("a categoria da triagem chega à auditoria e muda o que ela lê", () => {
  const prompt = renderPrompt(passo("audit").prompt, evento, new Map([["triage", triagem]]));

  assert.match(prompt, /Categoria da mudança: dependency\n/);
  assert.match(prompt, /changelog/);
  assert.match(prompt, /src\/Api\/Startup\.cs/);
});

test("interpolação desce em campo da saída de um passo e mantém a saída inteira", () => {
  const saidas = new Map<string, unknown>([["triage", triagem]]);

  assert.equal(renderPrompt("{{steps.triage.category}}", evento, saidas), "dependency");
  assert.equal(renderPrompt("{{steps.triage.sensitive_files}}", evento, saidas), JSON.stringify(triagem.sensitive_files, null, 2));
  assert.equal(renderPrompt("{{steps.triage}}", evento, saidas), JSON.stringify(triagem, null, 2));
  assert.equal(renderPrompt("{{steps.triage.nada}}", evento, saidas), "null");
});
