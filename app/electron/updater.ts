import { app, net } from "electron";
import http from "node:http";
import https from "node:https";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { updateService } from "../src/services/update-service.js";

/** Por que o verificador não subiu, quando não subiu. */
export type MotivoDaRecusa = "disabled" | "no-feed" | null;

export interface UpdaterState {
  /** `null` quando ninguém decidiu ainda. */
  preference: boolean | null;
  /** O que vale agora. Sem decisão, vale desligado. */
  enabled: boolean;
  /** Caminho da configuração de publicação, ou `null` quando não há nenhuma. */
  feed: string | null;
  /** Se o verificador foi de fato armado nesta subida. */
  armed: boolean;
  reason: MotivoDaRecusa;
}

let armado = false;

/**
 * Onde o electron-builder deixa a configuração de publicação.
 *
 * Empacotado ela vai para `Resources`, e é de lá que o electron-updater a lê.
 * Fora do pacote o próprio electron-updater procura por `dev-app-update.yml` na
 * raiz do app, que ninguém versiona: rodando do repositório não há feed, e essa
 * ausência é o que impede o smoke de sair para a rede por acidente.
 */
export function feedPath(): string | null {
  const caminho = app.isPackaged
    ? join(process.resourcesPath, "app-update.yml")
    : join(app.getAppPath(), "dev-app-update.yml");
  return existsSync(caminho) ? caminho : null;
}

/**
 * Decide se o verificador deve subir, sem subir nada.
 *
 * Fica separado do `setupUpdater` para que dar essa resposta nunca custe uma
 * chamada de rede. O smoke precisa exatamente disso: conferir que o interruptor
 * ligado é mesmo lido, sem que a leitura dispare a verificação contra o
 * servidor de releases.
 */
export async function planUpdater(): Promise<UpdaterState> {
  const { preference, enabled } = await updateService.state();
  const feed = feedPath();

  if (!enabled) return { preference, enabled, feed, armed: false, reason: "disabled" };
  if (feed === null) return { preference, enabled, feed, armed: false, reason: "no-feed" };
  return { preference, enabled, feed, armed: false, reason: null };
}

/**
 * Arma o verificador de atualização, se e só se alguém tiver ligado.
 *
 * Desligado, o `electron-updater` nem chega a ser importado. Não é economia de
 * memória: é a única forma de garantir que nenhum temporizador dele fique de
 * pé. Um módulo importado "só para consultar" é como um verificador acaba
 * batendo num servidor que o dono da máquina nunca autorizou.
 *
 * Sem configuração de publicação também não arma, e isso vale mesmo com o
 * interruptor ligado: sem certificado da Apple não há o que publicar, e o
 * `electron-updater` sem feed levanta erro na primeira verificação.
 */
export async function setupUpdater(): Promise<UpdaterState> {
  const plano = await planUpdater();

  if (plano.reason === "no-feed") {
    console.log("atualização: ligada, mas sem configuração de publicação, nada a verificar");
    return plano;
  }
  if (plano.reason !== null) return plano;

  const { autoUpdater } = await import("electron-updater");
  autoUpdater.logger = null;
  // A troca só acontece quando alguém fecha o Locum. Reiniciar por conta
  // própria no meio do dia derrubaria a bandeja e o agendador junto.
  autoUpdater.autoInstallOnAppQuit = true;
  armado = true;

  await autoUpdater.checkForUpdatesAndNotify();
  return { ...plano, armed: true };
}

/** Se o verificador chegou a ser armado nesta subida. Serve ao smoke. */
export function updaterArmed(): boolean {
  return armado;
}

/** Uma requisição que saiu enquanto a espia estava de pé. */
export interface RequisicaoVista {
  /** `http`, `https` ou `net`, conforme por onde saiu. */
  via: string;
  destino: string;
}

export interface EspiaDeRede {
  vistas(): RequisicaoVista[];
  parar(): void;
}

/**
 * Conta o que sai para a rede enquanto estiver de pé.
 *
 * Existe para o smoke: "desligado não faz chamada de rede" só se prova olhando
 * a saída, e não lendo o código que decide não chamar. Cobre os dois caminhos
 * que o `electron-updater` usa, o `net` do Electron quando ele está disponível
 * e o `http`/`https` do Node quando não está.
 *
 * O remendo é global e volta atrás no `parar()`. Fora do smoke ninguém chama
 * isto: contar toda requisição do processo em produção seria pagar por uma
 * informação que não muda nada.
 */
export function espiarRede(): EspiaDeRede {
  const vistas: RequisicaoVista[] = [];

  const originais = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netRequest: net.request,
  };

  const anotar =
    (via: string, original: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      vistas.push({ via, destino: descreverDestino(args[0]) });
      return (original as (...a: unknown[]) => unknown)(...args);
    };

  http.request = anotar("http", originais.httpRequest) as typeof http.request;
  http.get = anotar("http", originais.httpGet) as typeof http.get;
  https.request = anotar("https", originais.httpsRequest) as typeof https.request;
  https.get = anotar("https", originais.httpsGet) as typeof https.get;
  net.request = anotar("net", originais.netRequest) as typeof net.request;

  return {
    vistas: () => [...vistas],
    parar: () => {
      http.request = originais.httpRequest;
      http.get = originais.httpGet;
      https.request = originais.httpsRequest;
      https.get = originais.httpsGet;
      net.request = originais.netRequest;
    },
  };
}

function descreverDestino(alvo: unknown): string {
  if (typeof alvo === "string") return alvo;
  if (alvo instanceof URL) return alvo.toString();
  if (alvo !== null && typeof alvo === "object") {
    const opcoes = alvo as { url?: string; hostname?: string; host?: string; path?: string };
    if (typeof opcoes.url === "string") return opcoes.url;
    const host = opcoes.hostname ?? opcoes.host;
    if (host !== undefined) return `${host}${opcoes.path ?? ""}`;
  }
  return "?";
}
