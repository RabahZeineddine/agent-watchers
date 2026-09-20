import { useEffect, useRef, useState } from "react";
import type {
  BridgeChannel,
  LocumApi,
  LocumBridge,
} from "../../electron/bridge-contract.js";

/**
 * O lado da janela da ponte.
 *
 * O import do contrato e so de tipo: nada de `electron/` vira codigo aqui. O
 * que existe em tempo de execucao e o `window.locum`, que o preload pendurou, e
 * este modulo e a unica porta do renderer para ele. Componente nenhum fala com
 * `window.locum` direto, porque entao cada tela inventaria o proprio tratamento
 * de erro e a propria forma de esperar.
 */

/**
 * O catalogo de leitura, escrito a mao, canal por canal.
 *
 * A emenda 5 do ADR 0003 existe por causa desta lista: derivar o catalogo
 * varrendo `BRIDGE_CHANNELS` seria mais curto e entregaria `approvals.decide`
 * a qualquer modelo que rode na janela, junto com todo canal de escrita que
 * aparecer depois. Acrescentar canal aqui e um ato, nao uma consequencia.
 *
 * Fora da lista de proposito: `approvals.decide`, que e o clique de uma pessoa
 * na inbox e passa pela gate; e `runs.rerunStep`, `triggers.setEnabled`,
 * `startup.set`, `mcp.test` e `mcp.tools`, que escrevem ou sobem processo e
 * nao cabem num hook que dispara sozinho ao montar a tela. O que dessas a
 * janela ja pode pedir esta em `ACTION_CHANNELS`, logo abaixo.
 *
 * `credentials.overview` esta aqui e nao la porque ela nao abre o cofre: ela
 * responde endereco e se ha valor guardado, que e o que a tela de configuracao
 * mostra. Valor de segredo nao tem canal, em lista nenhuma.
 */
export const READ_CHANNELS = [
  "agents.list",
  "agents.get",
  "agents.versions",
  "agents.budgets",
  "runs.list",
  "runs.get",
  "runs.findings",
  "approvals.listPending",
  "approvals.get",
  "mcp.list",
  "providers.list",
  "providers.fallbacks",
  "providers.preview",
  "credentials.overview",
  "chat.status",
  "metrics.report",
  "machine.profile",
  "triggers.list",
  "startup.get",
  "i18n.state",
  "window.inboxTarget",
] as const satisfies readonly BridgeChannel[];

export type ReadChannel = (typeof READ_CHANNELS)[number];

/**
 * O catalogo de acao, tambem escrito a mao, e tambem canal por canal.
 *
 * Aqui mora o que a janela pode mandar fazer, e nao so perguntar. A lista e
 * separada da de leitura de proposito: quem le dispara sozinho ao montar a
 * tela, quem age precisa de alguem clicando, e misturar os dois num catalogo
 * so faria um hook de leitura alcancar escrita por descuido.
 *
 * Fora da lista, e pela mesma emenda 5 do ADR 0003 que rege a de leitura:
 * `approvals.decide`. Ela nao e uma acao da janela, e o clique de uma pessoa
 * na inbox, e chega ao processo principal por um caminho que a inbox monta,
 * nao por um catalogo que qualquer tela enxerga.
 *
 * `mcp.test` e `mcp.tools` estao aqui, e nao na lista de leitura, porque as
 * duas sobem o servidor que vao examinar. Numa tela que lista cadastros isso
 * significaria subir todo servidor registrado so de abrir o destino; atras de
 * um clique, sobe o que alguem pediu e so quando pediu.
 */
export const ACTION_CHANNELS = [
  "runs.rerunStep",
  "mcp.test",
  "mcp.tools",
  // Buscar catálogo bate na rede de cada provedor, então fica atrás de um
  // clique e não do carregamento da tela.
  "providers.models",
  "providers.allModels",
  "chat.setModel",
  "chat.send",
  "chat.cancel",
  // Escolher idioma é um clique de quem está usando, e a escrita em `settings`
  // vale para a próxima subida também. Não é leitura de tela.
  "i18n.setPreference",
] as const satisfies readonly BridgeChannel[];

export type ActionChannel = (typeof ACTION_CHANNELS)[number];

type AnyChannel = ReadChannel | ActionChannel;

export type ReadArgs<C extends AnyChannel> = Parameters<LocumApi[C]>;
export type ReadResult<C extends AnyChannel> = Awaited<ReturnType<LocumApi[C]>>;

/**
 * Guarda de compilacao contra o catalogo crescer para o lado errado.
 *
 * Revisao humana esquece; isto nao. Se `approvals.decide` entrar em
 * `READ_CHANNELS`, o `Extract` deixa de ser `never` e o `npm run build` para
 * antes de a janela enxergar o canal.
 */
type SemDecisao = [Extract<AnyChannel, "approvals.decide">] extends [never] ? true : never;
const _semDecisao: SemDecisao = true;
void _semDecisao;

/** O erro que este modulo devolve: sempre com mensagem legivel e o canal. */
export class BridgeError extends Error {
  constructor(
    readonly channel: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

function bridge(): LocumBridge {
  const exposta = globalThis.window?.locum;
  if (exposta === undefined) {
    throw new BridgeError("*", "a janela subiu sem a ponte, o preload nao rodou");
  }
  return exposta;
}

/**
 * Chama um canal de leitura e devolve o que o servico respondeu.
 *
 * O erro que vem do IPC chega como `Error` com a mensagem do lado de la
 * prefixada pelo Electron. Ele e reembalado com o nome do canal porque, sem
 * isso, uma tela com quatro leituras mostra "pendencia nao encontrada" sem
 * dizer de onde veio.
 */
async function invoke<C extends AnyChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  const [group, member] = channel.split(".") as [string, string];
  // O cast e a fronteira: o `window.locum` chega agrupado e indexar por string
  // perde o tipo. Quem sustenta a assinatura e o `ReadChannel` na entrada, que
  // so aceita canal do catalogo acima.
  const grupo = (bridge() as unknown as Record<string, Record<string, unknown>>)[group];
  const call = grupo?.[member] as ((...a: unknown[]) => Promise<ReadResult<C>>) | undefined;
  if (call === undefined) {
    throw new BridgeError(channel, `a ponte subiu sem o canal ${channel}`);
  }

  try {
    return await call(...args);
  } catch (erro) {
    throw new BridgeError(channel, erro instanceof Error ? erro.message : String(erro));
  }
}

export async function read<C extends ReadChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  return invoke(channel, ...args);
}

/**
 * Manda o processo principal fazer alguma coisa e espera o desfecho.
 *
 * E a mesma viagem de `read`, com outro catalogo na entrada. A funcao separada
 * nao e cerimonia: ela e o que impede um hook de leitura de aceitar canal de
 * escrita por engano, porque os dois tipos de canal nao se encontram em lugar
 * nenhum da assinatura.
 */
export async function call<C extends ActionChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  return invoke(channel, ...args);
}

export type ReadState<T> =
  | { status: "loading"; data: undefined; error: undefined }
  | { status: "ready"; data: T; error: undefined }
  | { status: "error"; data: undefined; error: BridgeError };

/**
 * Le um canal ao montar e devolve o estado da leitura.
 *
 * Os argumentos entram na dependencia por JSON e nao por identidade: quem
 * chama passa objeto literal, que muda de referencia a cada render, e comparar
 * por identidade dispararia a leitura em laco.
 */
export function useRead<C extends ReadChannel>(
  channel: C,
  ...args: ReadArgs<C>
): ReadState<ReadResult<C>> {
  const [state, setState] = useState<ReadState<ReadResult<C>>>({
    status: "loading",
    data: undefined,
    error: undefined,
  });

  const chave = JSON.stringify(args);
  // Sem a caixa, os argumentos entrariam na lista de dependencia do efeito e o
  // lint pediria o espalhamento, que traz a identidade de volta.
  const ultimos = useRef(args);
  ultimos.current = args;

  useEffect(() => {
    let vivo = true;
    setState({ status: "loading", data: undefined, error: undefined });

    read(channel, ...ultimos.current).then(
      (data) => {
        if (vivo) setState({ status: "ready", data, error: undefined });
      },
      (erro: unknown) => {
        if (!vivo) return;
        const embrulhado =
          erro instanceof BridgeError
            ? erro
            : new BridgeError(channel, erro instanceof Error ? erro.message : String(erro));
        setState({ status: "error", data: undefined, error: embrulhado });
      },
    );

    // O desmontar nao cancela o IPC, que nao tem cancelamento: ele so impede a
    // gravacao de estado em componente que ja saiu.
    return () => {
      vivo = false;
    };
  }, [channel, chave]);

  return state;
}
