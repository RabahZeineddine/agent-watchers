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
 * nao cabem num hook que dispara sozinho ao montar a tela.
 */
export const READ_CHANNELS = [
  "agents.list",
  "agents.get",
  "agents.versions",
  "runs.list",
  "runs.get",
  "runs.findings",
  "approvals.listPending",
  "approvals.get",
  "mcp.list",
  "providers.list",
  "providers.fallbacks",
  "metrics.report",
  "machine.profile",
  "triggers.list",
  "startup.get",
  "window.inboxTarget",
] as const satisfies readonly BridgeChannel[];

export type ReadChannel = (typeof READ_CHANNELS)[number];

export type ReadArgs<C extends ReadChannel> = Parameters<LocumApi[C]>;
export type ReadResult<C extends ReadChannel> = Awaited<ReturnType<LocumApi[C]>>;

/**
 * Guarda de compilacao contra o catalogo crescer para o lado errado.
 *
 * Revisao humana esquece; isto nao. Se `approvals.decide` entrar em
 * `READ_CHANNELS`, o `Extract` deixa de ser `never` e o `npm run build` para
 * antes de a janela enxergar o canal.
 */
type SemDecisao = [Extract<ReadChannel, "approvals.decide">] extends [never] ? true : never;
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
export async function read<C extends ReadChannel>(
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
