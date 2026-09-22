import type { TFunction } from "i18next";

/**
 * Os rótulos de severidade e de estado, que a inbox e as execuções mostram nos
 * mesmos crachás.
 *
 * O valor chega do banco como texto solto, e por isso passa antes pela lista
 * conhecida: com a guarda de chave ausente ligada, uma severidade ou um estado
 * novo gravado lá atrás derrubaria a tela inteira em vez de aparecer cru. Sem
 * tradução é ruim; tela em branco é pior.
 */

export const SEVERIDADES = ["critical", "high", "medium", "low"] as const;
export type Severidade = (typeof SEVERIDADES)[number];

/** Quanto a auditoria confia no próprio achado; pendência antiga vem sem. */
export const CONFIANCAS = ["high", "medium", "low"] as const;
export type Confianca = (typeof CONFIANCAS)[number];

export const ESTADOS = [
  "done",
  "running",
  "queued",
  "pending",
  "paused",
  "awaiting_approval",
  "skipped",
  "failed",
  "cancelled",
] as const;
export type Estado = (typeof ESTADOS)[number];

export function rotuloDeSeveridade(t: TFunction, severidade: string): string {
  return (SEVERIDADES as readonly string[]).includes(severidade)
    ? t(`severity.${severidade}`)
    : severidade;
}

export function rotuloDeEstado(t: TFunction, estado: string): string {
  return (ESTADOS as readonly string[]).includes(estado) ? t(`status.${estado}`) : estado;
}
