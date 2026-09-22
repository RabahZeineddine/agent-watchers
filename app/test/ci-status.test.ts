import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCiStatus, summarizeChecks, type CheckRun, type ChecksClient } from "../src/sources/ci-status.js";
import { fetchPr, type PrClient } from "../src/sources/github.js";
import { renderPrompt } from "../src/executor/executor.js";
import { demoPr } from "../src/seed/demo-event.js";
import { prReviewSpec } from "../src/seed/pr-review.js";

const check = (name: string, conclusion: string | null, status = "completed", title?: string): CheckRun => ({
  name,
  status,
  conclusion,
  output: title === undefined ? null : { title },
});

test("CI vermelho lista os checks que falharam, com o título da saída", () => {
  const ci = summarizeChecks([
    check("lint", "success"),
    check("build", "failure", "completed", "CS0103: o nome 'now' não existe no contexto"),
    check("testes", "timed_out"),
    check("sonar", null, "in_progress"),
  ]);

  assert.equal(ci.state, "failing");
  assert.match(ci.summary, /2 de 4/);
  assert.match(ci.summary, /build.*CS0103/);
  assert.match(ci.summary, /testes/);
  assert.match(ci.summary, /sonar/, "o que ainda roda também aparece");
  assert.doesNotMatch(ci.summary.split("\n").filter((l) => l.includes("lint")).join(), /falh/);
  assert.deepEqual(
    ci.checks.filter((c) => c.result === "failed").map((c) => c.name),
    ["build", "testes"],
  );
});

test("CI verde, pendente, cancelado e sem check nenhum têm estado próprio", () => {
  assert.equal(summarizeChecks([check("build", "success"), check("docs", "skipped")]).state, "passing");
  assert.equal(summarizeChecks([check("build", "success"), check("e2e", null, "queued")]).state, "pending");

  const cancelado = summarizeChecks([check("build", "success"), check("deploy", "cancelled")]);
  assert.equal(cancelado.state, "passing", "cancelado não é prova de defeito");
  assert.match(cancelado.summary, /deploy/);

  const nenhum = summarizeChecks([]);
  assert.equal(nenhum.state, "none");
  assert.ok(nenhum.summary.length > 0);
});

test("a leitura dos checks pede o commit de cabeça e não derruba a ingestão quando falha", async () => {
  const pedidos: unknown[] = [];
  const cliente: ChecksClient = {
    rest: { checks: { listForRef: (async () => ({})) as never } },
    paginate: (async (_rota: unknown, params: unknown) => {
      pedidos.push(params);
      return [check("build", "failure")];
    }) as never,
  };

  const ci = await fetchCiStatus(cliente, "o", "r", "abc123");
  assert.equal(ci.state, "failing");
  assert.deepEqual(pedidos, [{ owner: "o", repo: "r", ref: "abc123", filter: "latest", per_page: 100 }]);

  const recusa: ChecksClient = {
    rest: cliente.rest,
    paginate: (async () => {
      throw new Error("Resource not accessible by personal access token");
    }) as never,
  };
  const indisponivel = await fetchCiStatus(recusa, "o", "r", "abc123");
  assert.equal(indisponivel.state, "unavailable");
  assert.match(indisponivel.summary, /Resource not accessible/);
});

test("o evento do pull request guarda o resumo dos checks do commit de cabeça", async () => {
  const cliente = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            title: "t",
            body: "d",
            head: { sha: "cabeca", ref: "fix/x" },
            base: { ref: "main" },
            user: { login: "autora" },
            html_url: "https://example.invalid/pr/1",
            additions: 1,
            deletions: 1,
            draft: false,
          },
        }),
        listFiles: async () => ({}),
      },
      checks: { listForRef: async () => ({}) },
    },
    paginate: async (rota: unknown, params: { ref?: string }) => {
      if (rota === cliente.rest.checks.listForRef) {
        assert.equal(params.ref, "cabeca");
        return [check("build", "failure", "completed", "compilação quebrou")];
      }
      return [{ filename: "src/a.cs", status: "modified", additions: 1, deletions: 1, patch: "+x" }];
    },
  };

  const evento = await fetchPr("o", "r", 1, { client: cliente as unknown as PrClient, diffMaxChars: 100_000 });
  assert.equal(evento.ci?.state, "failing");
  assert.match(evento.ci?.summary ?? "", /compilação quebrou/);
});

test("o prompt da auditoria recebe o resumo e a instrução de não repetir o CI", () => {
  const passo = prReviewSpec.steps.find((s) => s.key === "audit");
  assert.ok(passo?.type === "model");

  const ci = summarizeChecks([check("build", "failure", "completed", "CS0103 em TokenValidator.cs")]);
  const prompt = renderPrompt(passo.prompt, { ...demoPr, ci }, new Map([["triage", { category: "fix" }]]));

  assert.match(prompt, /CS0103 em TokenValidator\.cs/);
  assert.match(prompt, /CI já/);
  assert.doesNotMatch(prompt, /\{\{/);
});
