import { Button } from "@/components/ui/button";
import { gravarRevisao, decidir } from "@/lib/aprovar";
import { useRead } from "@/lib/bridge";
import {
  CONFIANCAS,
  rotuloDeSeveridade,
  SEVERIDADES,
  type Confianca,
  type Severidade,
} from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TelaProps } from "../rotas";

interface AchadoEditavel {
  file?: string;
  line?: number;
  severity: Severidade;
  confidence?: Confianca;
  category?: string;
  problem: string;
  fix?: string;
  /** Desmarcado sai do que vai ser publicado, sem sumir da tela. */
  incluido: boolean;
}

const REGUA: Record<Severidade, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
};

/**
 * O que vai sair, antes de sair.
 *
 * Review de modelo quase nunca é oito ou oitenta: de quatro achados, três
 * prestam. Sem poder tirar um, a fila empurra a pessoa a aprovar ruído junto
 * com sinal, e aí a medição de precisão mede a paciência de quem aprovou, não a
 * qualidade do agent.
 *
 * Editar aqui não publica nada: grava na pendência, que continua esperando.
 */
export function Revisao({ detalhe, navegar }: TelaProps) {
  const { t } = useTranslation();
  const pendentes = useRead("approvals.listPending");
  const [achados, setAchados] = useState<AchadoEditavel[] | null>(null);
  const [gravando, setGravando] = useState(false);
  const [resolvendo, setResolvendo] = useState(false);
  const primeiroRender = useRef(true);

  const pendencia = useMemo(
    () =>
      pendentes.status === "ready"
        ? pendentes.data.find((p) => p.id === detalhe)
        : undefined,
    [pendentes, detalhe],
  );

  useEffect(() => {
    if (!pendencia || achados !== null) return;
    const carga = pendencia.payload as { findings?: unknown[] } | null;
    setAchados(
      (carga?.findings ?? []).map((bruto) => {
        const f = bruto as Record<string, unknown>;
        return {
          file: typeof f.file === "string" ? f.file : undefined,
          line: typeof f.line === "number" ? f.line : undefined,
          severity: (SEVERIDADES as readonly string[]).includes(String(f.severity))
            ? (f.severity as Severidade)
            : "low",
          confidence: (CONFIANCAS as readonly string[]).includes(String(f.confidence))
            ? (f.confidence as Confianca)
            : undefined,
          category: typeof f.category === "string" ? f.category : undefined,
          problem: typeof f.problem === "string" ? f.problem : "",
          fix: typeof f.fix === "string" ? f.fix : undefined,
          incluido: true,
        };
      }),
    );
  }, [pendencia, achados]);

  // Grava sozinho depois que a digitação para. Botão de salvar num editor de
  // um item só é cerimônia: o risco real é fechar a tela e perder a edição.
  useEffect(() => {
    if (achados === null || !pendencia) return;
    if (primeiroRender.current) {
      primeiroRender.current = false;
      return;
    }
    const id = setTimeout(() => {
      setGravando(true);
      void gravarRevisao(
        pendencia.id,
        achados.filter((a) => a.incluido).map(({ incluido: _, ...resto }) => resto),
      ).finally(() => setGravando(false));
    }, 700);
    return () => clearTimeout(id);
  }, [achados, pendencia]);

  if (pendentes.status === "ready" && !pendencia) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Voltar navegar={navegar} />
        <p className="text-muted-foreground mt-4 text-sm">{t("review.not_found")}</p>
      </div>
    );
  }
  if (!pendencia || achados === null) return null;

  const carga = pendencia.payload as {
    pull?: number;
    repo?: string;
    owner?: string;
    title?: string;
    author?: string;
    url?: string;
  } | null;
  const marcados = achados.filter((a) => a.incluido).length;

  async function resolver(decisao: "approved" | "rejected") {
    if (!pendencia) return;
    setResolvendo(true);
    try {
      await decidir(pendencia.id, decisao);
      navegar("inbox");
    } finally {
      setResolvendo(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-baseline gap-3">
        <Voltar navegar={navegar} />
        {carga?.pull && (
          <span className="font-mono text-[13px] font-medium">{t("common.pull", { number: carga.pull })}</span>
        )}
        <span className="text-muted-foreground truncate font-mono text-xs">
          {carga?.owner ? `${carga.owner}/` : ""}
          {carga?.repo ?? ""}
        </span>
        {carga?.url && (
          <a
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-xs"
            href={carga.url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="inline size-3" aria-hidden /> {t("common.open_github")}
          </a>
        )}
      </div>

      {carga?.title && <h1 className="text-lg font-semibold tracking-tight">{carga.title}</h1>}

      <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-lg border">
        {achados.map((achado, i) => (
          <li className={cn("relative", !achado.incluido && "opacity-45")} key={i}>
            <span
              aria-hidden
              className={cn("absolute top-0 bottom-0 left-0 w-[3px]", REGUA[achado.severity])}
            />
            <div className="py-3 pr-4 pl-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground font-mono text-xs">
                  {achado.file ?? ""}
                  {achado.line ? `:${achado.line}` : ""}
                </span>

                <select
                  aria-label={t("review.severity")}
                  className="border-border bg-background cursor-pointer rounded border px-1.5 py-0.5 text-xs"
                  onChange={(e) =>
                    setAchados((atual) =>
                      (atual ?? []).map((a, j) =>
                        j === i ? { ...a, severity: e.target.value as Severidade } : a,
                      ),
                    )
                  }
                  value={achado.severity}
                >
                  {SEVERIDADES.map((s) => (
                    <option key={s} value={s}>
                      {rotuloDeSeveridade(t, s)}
                    </option>
                  ))}
                </select>

                {achado.confidence && (
                  <span className="text-muted-foreground text-xs">
                    {t(`review.confidence.${achado.confidence}`)}
                  </span>
                )}

                <label className="text-muted-foreground ml-auto flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    checked={achado.incluido}
                    className="accent-primary cursor-pointer"
                    onChange={(e) =>
                      setAchados((atual) =>
                        (atual ?? []).map((a, j) =>
                          j === i ? { ...a, incluido: e.target.checked } : a,
                        ),
                      )
                    }
                    type="checkbox"
                  />
                  {t(achado.incluido ? "review.include" : "review.excluded")}
                </label>
              </div>

              <textarea
                aria-label={t("review.body_label")}
                className="focus:border-ring border-border bg-background mt-2 w-full resize-y rounded border px-2.5 py-2 text-sm leading-relaxed outline-none transition-colors duration-200"
                onChange={(e) =>
                  setAchados((atual) =>
                    (atual ?? []).map((a, j) => (j === i ? { ...a, problem: e.target.value } : a)),
                  )
                }
                rows={Math.min(8, Math.max(2, Math.ceil(achado.problem.length / 90)))}
                value={achado.problem}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <Button
          className="cursor-pointer"
          disabled={resolvendo || marcados === 0}
          onClick={() => void resolver("approved")}
        >
          {t("review.approve")}
        </Button>
        <Button
          className="text-muted-foreground hover:text-foreground cursor-pointer"
          disabled={resolvendo}
          onClick={() => void resolver("rejected")}
          variant="ghost"
        >
          {t("review.discard")}
        </Button>

        <span className="text-muted-foreground ml-auto text-xs">
          {gravando
            ? t("review.saving")
            : marcados === 0
              ? t("review.none_selected")
              : t("review.will_post", { count: marcados })}
        </span>

        <button
          className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
          onClick={() => navegar("execucoes", pendencia.runId)}
          type="button"
        >
          {t("review.see_run")}
        </button>
      </div>
    </div>
  );
}

function Voltar({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  return (
    <button
      className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-sm"
      onClick={() => navegar("inbox")}
      type="button"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {t("review.back")}
    </button>
  );
}
