import { Notification } from "electron";
import { t } from "./i18n.js";
import { noticeService, type Notice } from "../src/services/notice-service.js";

const POLL_MS = 20_000;

/** Chaves ja entregues nesta sessao. Ver `setupNotifications`. */
const delivered = new Set<string>();

let timer: NodeJS.Timeout | null = null;
let openInbox: ((runId: string) => void) | null = null;
let shown = 0;

export interface NotifyHandlers {
  /** Clique na notificacao: traz a janela e aponta a inbox para o run. */
  openInbox: (runId: string) => void;
}

/**
 * Liga o aviso nativo a fila.
 *
 * A primeira leitura so marca o que ja estava la, sem mostrar nada: subir o
 * Locum depois de uma semana desligado nao pode despejar uma pilha de
 * notificacoes de coisa velha. O que estava na fila antes de o app subir ja
 * aparece na contagem da bandeja, que e o lugar certo para o acumulado.
 * Notificacao e para o que chegou agora.
 *
 * Por isso a memoria do que foi avisado e desta sessao e nao vai para o banco:
 * ela so precisa durar enquanto o processo estiver no ar.
 */
export async function setupNotifications(handlers: NotifyHandlers): Promise<number> {
  openInbox = handlers.openInbox;

  const iniciais = await noticeService.pending();
  for (const notice of iniciais) delivered.add(notice.key);

  // A fila tambem muda fora deste processo: linha de comando e servidor MCP
  // gravam no mesmo banco. Sem evento para escutar, sobra reler.
  timer = setInterval(() => void deliverPending(), POLL_MS);

  return iniciais.length;
}

export function teardownNotifications(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  delivered.clear();
  openInbox = null;
}

/** Mostra o que apareceu desde a ultima leitura. Devolve quantas saiu. */
export async function deliverPending(): Promise<number> {
  if (!Notification.isSupported()) return 0;

  const novas = (await noticeService.pending()).filter((n) => !delivered.has(n.key));
  for (const notice of novas) {
    delivered.add(notice.key);
    buildNotification(notice).show();
    shown += 1;
  }
  return novas.length;
}

/**
 * A frase do aviso, no idioma que o processo principal esta falando.
 *
 * Ela nao vem pronta do servico: la mora o fato, e o texto e desta casca, que e
 * quem sabe para quem esta falando. A mensagem de erro do run e a unica parte
 * que sai como veio, porque ela e do provedor e traduzi-la seria inventar.
 */
export function noticeText(notice: Notice): { title: string; body: string } {
  if (notice.kind === "run_failed") {
    return {
      title: t("notification.runFailed.title", { agent: notice.agentName }),
      body: notice.error ?? t("notification.runFailed.noError"),
    };
  }

  return {
    title: t("notification.criticalFinding.title", {
      agent: notice.agentName,
      count: notice.criticalCount,
    }),
    body: t("notification.criticalFinding.body", { count: notice.criticalCount }),
  };
}

/**
 * Monta a notificacao sem mostrar, com o clique ja apontado para o run.
 *
 * Fica separada do `show()` para que o smoke possa provar o conteudo e o
 * destino do clique sem estourar um alerta na tela de quem esta trabalhando.
 */
export function buildNotification(notice: Notice): Notification {
  const { title, body } = noticeText(notice);
  const notification = new Notification({
    title,
    body,
    // Achado critico espera decisao de uma pessoa, entao o aviso fica na
    // central ate alguem olhar. Falha de run e informativa e pode sumir.
    timeoutType: notice.kind === "critical_finding" ? "never" : "default",
  });

  notification.on("click", () => openInbox?.(notice.runId));
  return notification;
}

/** Quantas notificacoes este processo mostrou de verdade. Serve ao smoke. */
export function notificationsShown(): number {
  return shown;
}
