import { powerMonitor } from "electron";
import { isPaused } from "./tray.js";
import { ligarRelogio, umaDeCadaVez, type Relogio } from "../src/triggers/clock.js";
import { scheduler } from "../src/triggers/scheduler.js";

/**
 * Quanto tempo a maquina ficou dormindo, em milissegundos, ou `null` quando o
 * suspend nao passou por aqui. Fica nulo quando o Locum subiu com a maquina ja
 * dormindo, ou quando o processo entrou no ar entre o suspend e o resume.
 */
export type WakeHandler = (sleptMs: number | null) => Promise<void> | void;

export interface PowerOptions {
  /** Trocavel pelo smoke, que conta batidas sem acordar gatilho de verdade. */
  onWake?: WakeHandler;
  /** Relogio, tambem so para o smoke poder simular uma noite inteira. */
  now?: () => number;
}

let suspendedAt: number | null = null;
let registered: { suspend: () => void; resume: () => void } | null = null;
let relogio: Relogio | null = null;

/**
 * Liga os eventos de energia do macOS ao agendador.
 *
 * O agendador nao tem relogio proprio, ele anda por cursor de tempo: a batida
 * que vem logo depois de acordar ja encontra vencido todo gatilho cuja janela
 * passou durante o sono, sem precisar de nada que recupere janela perdida. Por
 * isso aqui nao existe calculo de atraso, so a batida e o registro de quanto
 * tempo a maquina ficou fora.
 */
export function setupPower(options: PowerOptions = {}): void {
  if (registered !== null) return;

  const now = options.now ?? Date.now;
  const onWake = options.onWake ?? (() => baterUmaVez("wake"));

  const suspend = (): void => {
    suspendedAt = now();
    console.log("energia: maquina suspendendo");
  };

  const resume = (): void => {
    const slept = suspendedAt === null ? null : now() - suspendedAt;
    suspendedAt = null;
    console.log(`energia: maquina acordou depois de ${describeSleep(slept)}`);
    // O ouvinte do Electron e sincrono e ninguem espera por ele, entao a batida
    // segue solta e o erro dela precisa morrer aqui: promessa rejeitada sem
    // tratador derruba o processo principal e com ele a bandeja.
    void Promise.resolve(onWake(slept)).catch((err: unknown) => {
      console.error("energia: batida de acordar falhou", err);
    });
  };

  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  registered = { suspend, resume };
}

/**
 * Liga o relógio que bate o agendador com a máquina acordada.
 *
 * Fica separado do `setupPower` porque o smoke liga os eventos de energia para
 * provar que o resume chega ao agendador, e não pode ligar um relógio que sairia
 * batendo gatilho de verdade meio minuto depois.
 */
export function setupClock(): void {
  if (relogio !== null) return;
  relogio = ligarRelogio(() => baterUmaVez("timer"), {
    aoFalhar: (err) => console.error("relógio: batida falhou", err),
  });
}

export function teardownPower(): void {
  relogio?.parar();
  relogio = null;
  if (registered === null) return;
  powerMonitor.removeListener("suspend", registered.suspend);
  powerMonitor.removeListener("resume", registered.resume);
  registered = null;
  suspendedAt = null;
}

/** Quantos ouvintes cada evento de energia tem agora, deste modulo ou nao. */
export function powerListenerCount(): { suspend: number; resume: number } {
  return {
    suspend: powerMonitor.listenerCount("suspend"),
    resume: powerMonitor.listenerCount("resume"),
  };
}

/**
 * Dispara os ouvintes sem depender de o sistema dormir. Existe para o smoke,
 * que precisa provar que o resume chega ao agendador e nao pode pedir ao Mac
 * de quem desenvolve que tire um cochilo.
 */
export function emitPowerEvent(event: "suspend" | "resume"): void {
  powerMonitor.emit(event);
}

type Motivo = "wake" | "timer";

/**
 * O acordar e o relógio batem pela mesma porta, uma batida por vez: os dois
 * podem cair no mesmo segundo quando o Mac volta do sono.
 */
const baterUmaVez = umaDeCadaVez(beatScheduler);

/** A batida de verdade, que e o que roda quando ninguem troca o `onWake`. */
async function beatScheduler(motivo: Motivo): Promise<void> {
  const origem = motivo === "wake" ? "energia: batida de acordar" : "relógio: batida";
  if (isPaused()) {
    // O relógio bate a cada poucos minutos, e repetir o aviso a cada batida
    // pausada só enche o log. O acordar é raro e continua avisando.
    if (motivo === "wake") console.log("energia: pausado na bandeja, o agendador nao foi batido");
    return;
  }

  const result = await scheduler.tick({ reason: motivo });
  const fired = result.outcomes.filter((o) => o.status === "fired").length;
  const runs = result.outcomes.reduce((total, o) => total + o.runs.length, 0);
  const falhas = result.outcomes.filter((o) => o.status === "failed");
  for (const f of falhas) console.error(`${origem}: gatilho ${f.triggerId} falhou: ${f.detail ?? "sem detalhe"}`);
  if (result.reconciled.detail) console.error(`${origem}: conferência falhou: ${result.reconciled.detail}`);
  // Batida de relógio em que nada venceu é o caso comum e não merece linha.
  if (motivo === "timer" && fired === 0 && falhas.length === 0 && result.reconciled.settled === 0) return;
  console.log(
    `${origem} em ${result.outcomes.length} gatilho(s), ` +
      `${fired} disparado(s), ${runs} run(s) criado(s), ` +
      `${result.reconciled.settled} execução(ões) com desfecho`,
  );
}

function describeSleep(sleptMs: number | null): string {
  if (sleptMs === null) return "tempo desconhecido, o suspend nao passou por aqui";

  const minutes = Math.round(sleptMs / 60_000);
  if (minutes < 1) return `${Math.round(sleptMs / 1000)}s`;
  if (minutes < 60) return `${minutes}min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
