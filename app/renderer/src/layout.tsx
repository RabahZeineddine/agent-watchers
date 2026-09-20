import { useRead } from "@/lib/bridge";
import { useRota } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Paleta } from "./paleta";
import { ROTA_IDS, ROTA_PADRAO, ROTAS } from "./rotas";

/**
 * Estado da ponte, no rodape da barra lateral.
 *
 * Ele e so desenho: as leituras ficam no layout, porque a contagem da fila
 * tambem aparece ao lado da inbox e ler o mesmo canal nos dois lugares seriam
 * duas viagens pelo IPC para a mesma pergunta.
 *
 * O marcador existe para o smoke, que roda sem ninguem olhando e precisa
 * comparar o que a janela enxergou com o que os servicos devolvem do outro
 * lado. Ele carrega os identificadores dos agents, e nao so a contagem, porque
 * contagem igual por acaso passaria sem a ponte ter trazido nada.
 */
function Ponte({
  agents,
  erro,
  estado,
  execucoes,
  naFila,
}: {
  agents: string[];
  erro: { channel: string; message: string } | undefined;
  estado: "carregando" | "erro" | "pronto";
  execucoes: number;
  naFila: number;
}) {
  return (
    <div
      className="border-border border-t px-3 py-3 text-muted-foreground text-xs"
      data-agents={agents.join(",")}
      data-erro={erro?.message ?? ""}
      data-estado={estado}
      data-locum-probe="ponte"
      data-pendencias={naFila}
      data-runs={execucoes}
    >
      {erro !== undefined ? (
        <span>
          a ponte recusou {erro.channel}: {erro.message}
        </span>
      ) : estado === "carregando" ? (
        <span>lendo pela ponte...</span>
      ) : (
        <span>
          {agents.length} agent(s), {execucoes} execucao(oes)
        </span>
      )}
    </div>
  );
}

/**
 * A casca da janela: barra lateral com os quatro destinos, cabecalho com o
 * titulo do destino ativo, e a tela dele no corpo.
 */
export function Layout() {
  const { ativa, detalhe, navegar } = useRota(ROTA_IDS, ROTA_PADRAO);
  const rota = ROTAS.find((r) => r.id === ativa) ?? ROTAS[0];
  const { Tela } = rota;

  const agents = useRead("agents.list");
  const runs = useRead("runs.list");
  const pendencias = useRead("approvals.listPending");

  const erro = agents.error ?? runs.error ?? pendencias.error;
  const carregando =
    agents.status === "loading" || runs.status === "loading" || pendencias.status === "loading";
  const estado = erro !== undefined ? "erro" : carregando ? "carregando" : "pronto";
  const naFila = pendencias.data?.length ?? -1;

  return (
    <div className="flex h-screen bg-background text-foreground">
      <nav className="flex w-56 shrink-0 flex-col border-border border-r">
        <div
          className="px-4 pt-6 pb-4 font-semibold text-sm tracking-tight"
          data-locum-probe="marca"
        >
          Locum
        </div>

        <ul className="flex-1 space-y-1 px-2">
          {ROTAS.map(({ id, titulo, icone: Icone }) => (
            <li key={id}>
              <button
                aria-current={id === ativa ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  id === ativa
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )}
                data-locum-rota={id}
                onClick={() => navegar(id)}
                type="button"
              >
                <Icone className="size-4" />
                <span className="flex-1">{titulo}</span>
                {id === "inbox" && naFila > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 text-primary-foreground text-xs">
                    {naFila}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        <Ponte
          agents={(agents.data ?? []).map((a) => a.id)}
          erro={erro}
          estado={estado}
          execucoes={runs.data?.length ?? -1}
          naFila={naFila}
        />
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center border-border border-b px-6 py-4">
          <h1 className="font-semibold text-lg">{rota.titulo}</h1>
        </header>
        <main
          className="min-h-0 flex-1 overflow-auto px-6 py-6"
          data-ativo={ativa}
          data-detalhe={detalhe ?? ""}
          data-locum-probe="rota"
        >
          <Tela detalhe={detalhe} navegar={navegar} />
        </main>
      </div>

      <Paleta />

      {/*
        Marcador do smoke. Ele confere que este elemento esta com display none,
        o que so acontece se a folha construida pelo Tailwind chegou na pagina:
        raiz montada prova o React, nao prova o CSS.
      */}
      <span className="hidden" data-locum-probe="tailwind">
        folha de estilo carregada
      </span>
    </div>
  );
}
