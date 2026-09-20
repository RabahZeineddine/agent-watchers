import { app } from "electron";
import { startupService } from "../src/services/startup-service.js";

/** O que o banco guarda e o que o sistema responde, lado a lado. */
export interface LoginItemState {
  /** `null` quando ninguem decidiu ainda. */
  preference: boolean | null;
  /** O que o macOS diz sobre o item de login neste momento. */
  openAtLogin: boolean;
  /** `not-registered`, `enabled`, `requires-approval` ou `not-found`. */
  status: string;
}

/** O que o sistema responde agora, sem passar pelo banco. */
export function readLoginItem(): Pick<LoginItemState, "openAtLogin" | "status"> {
  const settings = app.getLoginItemSettings();
  return { openAtLogin: settings.openAtLogin, status: settings.status };
}

/**
 * Escreve no sistema.
 *
 * Fora de app empacotado, assinado e notarizado o macOS aceita a chamada e nao
 * registra nada, sem levantar erro. Por isso quem chama nao deve tratar o
 * retorno como confirmacao: a preferencia do banco e que manda, e o sistema e
 * reconciliado com ela a cada subida.
 */
export function writeLoginItem(openAtLogin: boolean): Pick<LoginItemState, "openAtLogin" | "status"> {
  app.setLoginItemSettings({ openAtLogin });
  return readLoginItem();
}

/**
 * Poe o sistema de acordo com a preferencia guardada. Sem preferencia, nao
 * toca em nada: a decisao de subir no login e de quem instala, e a primeira
 * execucao nao pode tomar essa decisao no lugar dele.
 */
export async function applyPreference(): Promise<LoginItemState> {
  const preference = await startupService.getPreference();
  const system = preference === null ? readLoginItem() : writeLoginItem(preference);
  return { preference, ...system };
}

/** Grava a preferencia e ja reconcilia o sistema com ela. */
export async function setPreference(enabled: boolean): Promise<LoginItemState> {
  await startupService.setPreference(enabled);
  return applyPreference();
}
