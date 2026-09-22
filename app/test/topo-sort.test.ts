import { test } from "node:test";
import assert from "node:assert/strict";
import { Step, topoSort } from "../src/config/types.js";

const passo = (key: string, needs: string[] = []): Step =>
  Step.parse({ type: "model", key, name: key, model: "anthropic/modelo", prompt: "p", needs });

const chaves = (steps: Step[]) => steps.map((s) => s.key);

test("dependência vem antes de quem depende dela, mesmo declarada depois", () => {
  const ordem = chaves(topoSort([passo("c", ["b"]), passo("b", ["a"]), passo("a")]));
  assert.deepEqual(ordem, ["a", "b", "c"]);
});

test("passos independentes mantêm a ordem em que foram declarados", () => {
  assert.deepEqual(chaves(topoSort([passo("x"), passo("y"), passo("z")])), ["x", "y", "z"]);
});

test("dependência compartilhada aparece uma vez só", () => {
  const ordem = chaves(topoSort([passo("a"), passo("b", ["a"]), passo("c", ["a", "b"])]));
  assert.deepEqual(ordem, ["a", "b", "c"]);
});

test("ciclo entre passos lança e mostra o caminho", () => {
  assert.throws(
    () => topoSort([passo("a", ["c"]), passo("b", ["a"]), passo("c", ["b"])]),
    /ciclo entre passos: a -> c -> b -> a/,
  );
});

test("passo que depende de si mesmo é ciclo", () => {
  assert.throws(() => topoSort([passo("a", ["a"])]), /ciclo entre passos: a -> a/);
});

test("dependência de passo inexistente lança", () => {
  assert.throws(() => topoSort([passo("a", ["fantasma"])]), /"fantasma" depende de um passo inexistente/);
});
