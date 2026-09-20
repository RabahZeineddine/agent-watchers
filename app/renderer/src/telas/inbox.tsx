import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { decidir } from "@/lib/aprovar";
import { read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDeSeveridade, SEVERIDADES, type Severidade } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { AlertTriangle, Check, ChevronRight, Inbox as InboxIcon, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";

type Pendencia = ReadResult<"approvals.listPending">[number];
type Execucao = ReadResult<"runs.list">[number];
type Achado = ReadResult<"runs.findings">[number];

/**
 * Palavra junto da cor, sempre. Cor sozinha nao chega para quem nao distingue
 * vermelho de verde, e tambem nao chega para quem esta de relance.
 */
const PONTO: Record<Severidade, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-amber-400",
  low: "bg-slate-400",
};

function pior(achados: Achado[]): Severidade {
  for (const s of SEVERIDADES) {
    if (achados.some((a) => a.severity === s)) return s;
  }
  return "low";
}

/** Idade em palavra, porque timestamp exige conta mental. */
function idade(t: TFunction, segundos: number): { texto: string; velho: boolean } {
  const h = Math.floor((Date.now() / 1000 - segundos) / 3600);
  if (h < 1) return { texto: t("inbox.age.now"), velho: false };
  if (h < 24) return { texto: t("inbox.age.hours", { hours: h }), velho: false };
  const d = Math.floor(h / 24);
  return { texto: t("inbox.age.days", { days: d }), velho: d >= 2 };
}

interface Item {
  pendencia: Pendencia;
  achados: Achado[];
  severidade: Severidade;
}

export function Inbox({ navegar }: TelaProps) {
  const pendentes = useRead("approvals.listPending");
  const execucoes = useRead("runs.list", { status: "failed", limit: 20 });
  const [itens, setItens] = useState<Item[] | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [foco, setFoco] = useState(0);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const listaRef = useRef<HTMLUListElement>(null);
  const [alvo, setAlvo] = useState<string | null>(null);

  // Os achados vivem no run, nao na pendencia. Carregados aqui para que a linha
  // fechada ja diga o suficiente para decidir, que e o ponto da tela.
  useEffect(() => {
    if (pendentes.status !== "ready") return;
    let cancelado = false;
    void (async () => {
      const carregados = await Promise.all(
        pendentes.data.map(async (p) => {
          const achados = await read("runs.findings", p.runId).catch(() => [] as Achado[]);
          return { pendencia: p, achados, severidade: pior(achados) };
        }),
      );
      if (!cancelado) setItens(ordenar(carregados));
    })();
    return () => {
      cancelado = true;
    };
  }, [pendentes.status, pendentes.status === "ready" ? pendentes.data : null]);

  // O alvo vindo do clique na notificacao abre direto o item daquele run.
  useEffect(() => {
    void read("window.inboxTarget").then(setAlvo).catch(() => setAlvo(null));
  }, []);

  useEffect(() => {
    if (!alvo || !itens) return;
    const i = itens.findIndex((x) => x.pendencia.runId === alvo);
    if (i >= 0) {
      setFoco(i);
      setAberto(itens[i]!.pendencia.id);
    }
  }, [alvo, itens]);

  const resolver = useCallback(
    async (item: Item, decisao: "approved" | "rejected") => {
      setOcupado(item.pendencia.id);
      try {
        await decidir(item.pendencia.id, decisao);
        setItens((atual) => atual?.filter((x) => x.pendencia.id !== item.pendencia.id) ?? null);
      } finally {
        setOcupado(null);
      }
    },
    [],
  );

  // Teclado antes do mouse: a fila e trabalho repetitivo, e tirar a mao do
  // teclado a cada item e o que faz uma inbox parecer longa.
  useEffect(() => {
    const lista = itens ?? [];
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const alvo = e.target as HTMLElement | null;
      if (alvo && ["INPUT", "TEXTAREA"].includes(alvo.tagName)) return;
      const item = lista[foco];

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFoco((f) => Math.min(f + 1, Math.max(lista.length - 1, 0)));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFoco((f) => Math.max(f - 1, 0));
      } else if (e.key === "Enter" && item) {
        e.preventDefault();
        setAberto((a) => (a === item.pendencia.id ? null : item.pendencia.id));
      } else if (e.key === "a" && item) {
        e.preventDefault();
        void resolver(item, "approved");
      } else if (e.key === "x" && item) {
        e.preventDefault();
        void resolver(item, "rejected");
      } else if (e.key === "e" && item) {
        e.preventDefault();
        navegar("execucoes", item.pendencia.runId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [itens, foco, resolver, navegar]);

  useEffect(() => {
    listaRef.current
      ?.querySelectorAll("li")
      [foco]?.scrollIntoView({ block: "nearest" });
  }, [foco]);

  const falhas = execucoes.status === "ready" ? execucoes.data : [];

  if (itens === null) return <Esqueleto />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Cabecalho quantidade={itens.length} />
      {falhas.length > 0 && <FaixaDeFalha quantidade={falhas.length} navegar={navegar} />}

      {itens.length === 0 ? (
        <Vazio />
      ) : (
        <ul ref={listaRef} className="flex flex-col gap-1.5">
          {itens.map((item, i) => (
            <Linha
              key={item.pendencia.id}
              item={item}
              focada={i === foco}
              aberta={aberto === item.pendencia.id}
              ocupada={ocupado === item.pendencia.id}
              aoFocar={() => setFoco(i)}
              aoAlternar={() =>
                setAberto((a) => (a === item.pendencia.id ? null : item.pendencia.id))
              }
              aoAprovar={() => void resolver(item, "approved")}
              aoDescartar={() => void resolver(item, "rejected")}
              aoEditar={() => navegar("execucoes", item.pendencia.runId)}
            />
          ))}
        </ul>
      )}

      <Atalhos />
    </div>
  );
}

/**
 * Ordem: quem espera ha mais tempo sobe, e a severidade decide o empate.
 *
 * O contrario, severidade pura, deixa achado medio apodrecendo no fim da fila
 * para sempre. A severidade pesa no visual, que e onde ela precisa pesar.
 */
function ordenar(itens: Item[]): Item[] {
  const peso = (s: Severidade) => SEVERIDADES.indexOf(s);
  return [...itens].sort((a, b) => {
    const idadeA = a.pendencia.createdAt;
    const idadeB = b.pendencia.createdAt;
    if (Math.abs(idadeA - idadeB) > 3600) return idadeA - idadeB;
    return peso(a.severidade) - peso(b.severidade);
  });
}

function Cabecalho({ quantidade }: { quantidade: number }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-baseline justify-between">
      <h1 className="text-lg font-semibold tracking-tight">{t("inbox.title")}</h1>
      {/*
        O marcador existe para o smoke, que confere o texto contra o dicionario
        nos dois idiomas: atributo com a contagem provaria que o estado chegou,
        e nao que a frase trocou de idioma.
      */}
      <p
        className="text-muted-foreground text-sm tabular-nums"
        data-locum-probe="inbox"
        data-pendencias={quantidade}
      >
        {t("inbox.waiting", { count: quantidade })}
      </p>
    </div>
  );
}

/**
 * Execucao que falhou nao e decisao, e atencao. Misturar as duas na mesma lista
 * apaga a pergunta que a tela faz, que e "o que eu decido agora".
 */
function FaixaDeFalha({
  quantidade,
  navegar,
}: {
  quantidade: number;
  navegar: TelaProps["navegar"];
}) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={() => navegar("execucoes")}
      className="border-border/60 bg-muted/40 hover:bg-muted focus-visible:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden />
      <span className="text-muted-foreground">{t("inbox.failures", { count: quantidade })}</span>
      <ChevronRight className="text-muted-foreground ml-auto size-4" aria-hidden />
    </button>
  );
}

interface LinhaProps {
  item: Item;
  focada: boolean;
  aberta: boolean;
  ocupada: boolean;
  aoFocar: () => void;
  aoAlternar: () => void;
  aoAprovar: () => void;
  aoDescartar: () => void;
  aoEditar: () => void;
}

function Linha({
  item,
  focada,
  aberta,
  ocupada,
  aoFocar,
  aoAlternar,
  aoAprovar,
  aoDescartar,
  aoEditar,
}: LinhaProps) {
  const { t } = useTranslation();
  const { pendencia, achados, severidade } = item;
  const { texto: quando, velho } = idade(t, pendencia.createdAt);
  const principal = achados[0];
  const alvo = alvoDaPendencia(pendencia);

  return (
    <li
      onMouseEnter={aoFocar}
      className={cn(
        "group border-border/60 bg-card rounded-md border transition-colors duration-200",
        focada && "border-ring/70 bg-accent/30",
        ocupada && "opacity-50",
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <span
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", PONTO[severidade])}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{alvo}</span>
            <Badge variant="outline" className="shrink-0 text-[11px] font-normal">
              {rotuloDeSeveridade(t, severidade)}
            </Badge>
            <span
              className={cn(
                "ml-auto shrink-0 text-xs tabular-nums",
                velho ? "text-amber-500" : "text-muted-foreground",
              )}
            >
              {quando}
            </span>
          </div>

          <p className="text-muted-foreground mt-0.5 truncate text-sm">
            {achados.length === 0
              ? pendencia.stepName
              : t("inbox.summary", { count: achados.length, problem: principal?.problem ?? "" })}
          </p>

          <div className="mt-2 flex items-center gap-1">
            <Button size="sm" className="h-8 cursor-pointer" onClick={aoAprovar} disabled={ocupada}>
              <Check className="size-3.5" aria-hidden />
              {t("inbox.approve")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 cursor-pointer"
              onClick={aoEditar}
              disabled={ocupada}
            >
              <Pencil className="size-3.5" aria-hidden />
              {t("inbox.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground h-8 cursor-pointer"
              onClick={aoDescartar}
              disabled={ocupada}
            >
              <X className="size-3.5" aria-hidden />
              {t("inbox.discard")}
            </Button>
            {achados.length > 1 && (
              <button
                type="button"
                onClick={aoAlternar}
                aria-expanded={aberta}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring ml-auto cursor-pointer rounded px-2 py-1 text-xs transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
              >
                {aberta ? t("inbox.collapse") : t("inbox.expand", { count: achados.length })}
              </button>
            )}
          </div>
        </div>
      </div>

      {aberta && achados.length > 0 && (
        <ul className="border-border/60 border-t">
          {achados.map((a, i) => (
            <li key={i} className="flex gap-2 px-3 py-2 pl-8 text-sm">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  PONTO[(a.severity as Severidade) ?? "low"],
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <span className="text-muted-foreground font-mono text-xs">
                  {a.file ?? t("findings.general")}
                  {a.line ? `:${a.line}` : ""}
                </span>
                <p className="mt-0.5">{a.problem}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** O alvo importa mais que o identificador da pendencia, entao vem primeiro. */
function alvoDaPendencia(p: Pendencia): string {
  const carga = p.payload as { owner?: string; repo?: string; pull?: number } | null;
  if (carga?.repo && carga.pull) {
    return `PR #${carga.pull} · ${carga.owner ? `${carga.owner}/` : ""}${carga.repo}`;
  }
  return `${p.agentName} · ${p.stepName}`;
}

/**
 * Vazio confirma que o sistema rodou, e nao que ele parou. Sem isso, fila vazia
 * e fila quebrada sao a mesma tela.
 */
function Vazio() {
  const { t } = useTranslation();

  return (
    <div className="border-border/60 flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-14 text-center">
      <InboxIcon className="text-muted-foreground/60 size-6" aria-hidden />
      <p className="text-sm font-medium">{t("inbox.empty.title")}</p>
      <p className="text-muted-foreground max-w-sm text-sm">{t("inbox.empty.body")}</p>
    </div>
  );
}

function Atalhos() {
  const { t } = useTranslation();
  // A tecla e a mesma em qualquer idioma: ela e o que se aperta, e nao o que se
  // le. So a acao ao lado passa pelo dicionario.
  const teclas: [string, string][] = [
    ["j / k", t("inbox.shortcuts.move")],
    ["enter", t("inbox.shortcuts.open")],
    ["a", t("inbox.shortcuts.approve")],
    ["e", t("inbox.shortcuts.edit")],
    ["x", t("inbox.shortcuts.discard")],
  ];
  return (
    <p className="text-muted-foreground/70 mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {teclas.map(([k, o]) => (
        <span key={k}>
          <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">{k}</kbd> {o}
        </span>
      ))}
    </p>
  );
}

function Esqueleto() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border-border/60 bg-card h-24 animate-pulse rounded-md border" />
      ))}
    </div>
  );
}
