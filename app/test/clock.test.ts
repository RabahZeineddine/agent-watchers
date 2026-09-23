import { test } from "node:test";
import assert from "node:assert/strict";
import { ligarRelogio, umaDeCadaVez } from "../src/triggers/clock.js";

/**
 * O relógio que bate o agendador com o aplicativo aberto.
 *
 * O tempo entra por um agendador de mentira, que guarda o que foi pedido e só
 * dispara quando o teste manda. Nada aqui espera relógio de verdade.
 */

function agendadorDeMentira() {
  const fila: { fn: () => void; ms: number; id: number }[] = [];
  let proximoId = 0;
  return {
    fila,
    agendar: (fn: () => void, ms: number) => {
      const id = ++proximoId;
      fila.push({ fn, ms, id });
      return id;
    },
    cancelar: (id: unknown) => {
      const i = fila.findIndex((p) => p.id === id);
      if (i >= 0) fila.splice(i, 1);
    },
    /** Dispara o próximo pedido e deixa as promessas dele assentarem. */
    async disparar() {
      const p = fila.shift();
      assert.ok(p, "nada agendado para disparar");
      p.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

test("a primeira batida vem logo e as seguintes na cadência", async () => {
  const tempo = agendadorDeMentira();
  let batidas = 0;
  ligarRelogio(async () => void batidas++, { ...tempo, primeiraMs: 30, cadenciaMs: 300 });

  assert.deepEqual(tempo.fila.map((p) => p.ms), [30]);
  await tempo.disparar();
  assert.equal(batidas, 1);
  assert.deepEqual(tempo.fila.map((p) => p.ms), [300]);
  await tempo.disparar();
  assert.equal(batidas, 2);
});

test("batida que falha não para o relógio", async () => {
  const tempo = agendadorDeMentira();
  const erros: unknown[] = [];
  ligarRelogio(
    async () => {
      throw new Error("GitHub fora do ar");
    },
    { ...tempo, aoFalhar: (e) => erros.push(e) },
  );

  await tempo.disparar();
  assert.equal(erros.length, 1);
  assert.equal(tempo.fila.length, 1, "depois da falha a próxima batida tem de estar agendada");
});

test("a próxima batida só é agendada quando a anterior termina", async () => {
  const tempo = agendadorDeMentira();
  let soltar!: () => void;
  ligarRelogio(() => new Promise<void>((r) => (soltar = r)), tempo);

  await tempo.disparar();
  assert.equal(tempo.fila.length, 0, "varredura lenta não pode empilhar outra atrás");
  soltar();
  await new Promise((r) => setImmediate(r));
  assert.equal(tempo.fila.length, 1);
});

test("parar cancela o que estava agendado", async () => {
  const tempo = agendadorDeMentira();
  const relogio = ligarRelogio(async () => {}, tempo);
  relogio.parar();
  assert.equal(tempo.fila.length, 0);
});

test("duas batidas ao mesmo tempo viram uma só", async () => {
  let chamadas = 0;
  let soltar!: () => void;
  const bater = umaDeCadaVez(() => {
    chamadas++;
    return new Promise<void>((r) => (soltar = r));
  });

  const acordar = bater();
  const relogio = bater();
  assert.equal(chamadas, 1, "a segunda batida não pode varrer o mesmo gatilho de novo");
  soltar();
  await Promise.all([acordar, relogio]);

  // Terminada a primeira, a próxima volta a bater de verdade.
  void bater();
  assert.equal(chamadas, 2);
  soltar();
});
