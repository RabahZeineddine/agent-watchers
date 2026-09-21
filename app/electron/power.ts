import { powerMonitor } from "electron";
import { isPaused } from "./tray.js";
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
  const onWake = options.onWake ?? beatScheduler;

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

export function teardownPower(): void {
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

/** A batida de verdade, que e o que roda quando ninguem troca o `onWake`. */
async function beatScheduler(): Promise<void> {
  if (isPaused()) {
    console.log("energia: pausado na bandeja, o agendador nao foi batido");
    return;
  }

  const result = await scheduler.onWake();
  const fired = result.outcomes.filter((o) => o.status === "fired").length;
  const runs = result.outcomes.reduce((total, o) => total + o.runs.length, 0);
  console.log(
    `energia: batida de acordar em ${result.outcomes.length} gatilho(s), ` +
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
