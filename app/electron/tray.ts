import { app, Menu, nativeImage, Tray } from "electron";
import { t } from "./i18n.js";
import { VERSAO } from "./versao.js";
import { approvalService } from "../src/services/approval-service.js";

// O icone vive em base64 aqui dentro em vez de num arquivo porque o build
// empacota o processo principal num unico dist/main.cjs, e um PNG solto
// exigiria um passo de copia so para ele. Sao 16x16 em template image: o macOS
// olha so o alfa e inverte a cor sozinho conforme o tema da barra.
const ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNgoBH4jwNTpJkoQwgpwitPrDOxqiPJj9jU4zKAaHFsCvEFHn0MoNgL+ABFMUFRWiApNdIkP1AfAABzd0+xlolxwAAAAABJRU5ErkJggg==";

const REFRESH_MS = 15_000;

let tray: Tray | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let openWindow: (() => void) | null = null;
let pendingCount = 0;
let paused = false;

export interface TrayHandlers {
  /** Chamado pelo item Abrir do menu. */
  openWindow: () => void;
}

/**
 * Pausa global, so na memoria deste processo.
 *
 * Nao vai para o banco de proposito: pausar e uma decisao sobre esta sessao da
 * maquina, e gravar isso apagaria a diferenca entre "o dono pausou agora" e
 * "este gatilho esta desabilitado", que e outra coisa e mora na tabela de
 * gatilhos. Quem dispara trabalho no processo principal consulta esta funcao
 * antes de comecar: hoje e a batida de acordar, em electron/power.ts.
 */
export function isPaused(): boolean {
  return paused;
}

/** Ultima contagem lida da fila, sem tocar no banco. */
export function trayPendingCount(): number {
  return pendingCount;
}

export async function setupTray(handlers: TrayHandlers): Promise<Tray> {
  openWindow = handlers.openWindow;

  const image = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_BASE64}`);
  // Base64 corrompido nao levanta erro: vira imagem vazia, e a bandeja fica
  // invisivel na barra sem ninguem perceber.
  if (image.isEmpty()) throw new Error("icone da bandeja nao decodificou");
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip("Locum");
  await refreshTray();

  // A fila tambem muda fora deste processo: a linha de comando e o servidor MCP
  // gravam no mesmo banco. Sem evento para escutar, sobra reler de tempos em
  // tempos. Quem mexer na fila aqui dentro chama refreshTray() na hora, e nao
  // espera a proxima leitura.
  refreshTimer = setInterval(() => void refreshTray(), REFRESH_MS);

  return tray;
}

/** Rele a fila e reescreve contagem e menu. Devolve quantas pendencias ha. */
export async function refreshTray(): Promise<number> {
  pendingCount = (await approvalService.listPending()).length;

  if (tray !== null && !tray.isDestroyed()) {
    tray.setTitle(pendingCount > 0 ? String(pendingCount) : "");
    tray.setContextMenu(buildMenu());
  }

  return pendingCount;
}

export function teardownTray(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  tray?.destroy();
  tray = null;
}

/** Os rotulos do menu como ele esta agora. Serve ao smoke, que nao clica. */
export function trayMenuLabels(): string[] {
  return buildMenu().items.map((item) => item.label);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      // Fila vazia e outra frase, e nao outra forma de plural: quem decide e o
      // `_zero` do dicionario, junto das demais formas, e nao um ternario aqui.
      label: t("tray.pending", { count: pendingCount }),
      enabled: false,
    },
    { type: "separator" },
    { label: t("tray.open"), click: () => openWindow?.() },
    {
      label: t(paused ? "tray.resume" : "tray.pause"),
      click: () => {
        paused = !paused;
        void refreshTray();
      },
    },
    { type: "separator" },
    { label: t("tray.version", { version: VERSAO }), enabled: false },
    { label: t("menu.app.about"), click: () => app.showAboutPanel() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);
}
