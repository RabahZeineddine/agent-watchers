import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel, type FallbackRow, type ProviderEntry } from "../src/providers/registry.js";

// Provedores de mentira: só a disponibilidade importa para a resolução, e o
// registro de verdade dependeria do ambiente e do binário desta máquina.
const provedores = (disponiveis: string[]): Record<string, ProviderEntry> =>
  Object.fromEntries(
    ["a", "b", "c", "d"].map((id) => [id, { available: () => disponiveis.includes(id), requires: [] }]),
  );

const fallback = (fromModel: string, toModel: string, order = 0): FallbackRow => ({ fromModel, toModel, order });

test("modelo disponível é usado sem substituição", () => {
  const r = resolveModel("a/m", [fallback("a/m", "b/m")], provedores(["a", "b"]));
  assert.equal(r.used, "a/m");
  assert.equal(r.substitutionReason, undefined);
});

test("indisponível segue a cadeia e conta as substituições", () => {
  const r = resolveModel("a/m", [fallback("a/m", "b/m"), fallback("b/m", "c/m")], provedores(["c"]));
  assert.equal(r.used, "c/m");
  assert.equal(r.provider, "c");
  assert.equal(r.model, "m");
  assert.match(r.substitutionReason ?? "", /2 substituicao/);
});

test("entre fallbacks do mesmo modelo vale a menor ordem", () => {
  const r = resolveModel(
    "a/m",
    [fallback("a/m", "c/m", 2), fallback("a/m", "b/m", 1)],
    provedores(["b", "c"]),
  );
  assert.equal(r.used, "b/m");
});

test("provedor que não existe no registro conta como indisponível", () => {
  const r = resolveModel("zzz/m", [fallback("zzz/m", "a/m")], provedores(["a"]));
  assert.equal(r.used, "a/m");
});

test("ciclo na tabela termina com erro em vez de girar para sempre", () => {
  assert.throws(
    () => resolveModel("a/m", [fallback("a/m", "b/m"), fallback("b/m", "a/m")], provedores([])),
    /sem fallback restante \(parou em "b\/m"\)/,
  );
});

test("ciclo não esconde a saída que existe por outro caminho", () => {
  const r = resolveModel(
    "a/m",
    [fallback("a/m", "b/m"), fallback("b/m", "a/m", 1), fallback("b/m", "c/m", 2)],
    provedores(["c"]),
  );
  assert.equal(r.used, "c/m");
});

test("sem fallback nenhum, erro nomeia o modelo pedido", () => {
  assert.throws(() => resolveModel("a/m", [], provedores([])), /modelo "a\/m" indisponivel/);
});
