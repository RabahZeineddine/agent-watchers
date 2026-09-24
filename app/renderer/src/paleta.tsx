import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A paleta de comandos, ainda sem comando nenhum.
 *
 * O que entra nesta story e o atalho e a moldura. As acoes ficam para depois,
 * e de proposito: a paleta e o lugar mais tentador para pendurar "aprovar
 * pendencia", e a emenda 5 do ADR 0003 diz que decisao de publicacao nao mora
 * em catalogo. Quando houver acao aqui, ela sera lista escrita a mao, pelo
 * mesmo motivo que o catalogo de canais e.
 */
export function Paleta() {
  const { t } = useTranslation();
  const [aberta, setAberta] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ouvir = (evento: KeyboardEvent) => {
      // `metaKey` no macOS, `ctrlKey` para quem chegar de teclado de PC.
      if (evento.key.toLowerCase() === "k" && (evento.metaKey || evento.ctrlKey)) {
        evento.preventDefault();
        setAberta((antes) => !antes);
        return;
      }
      if (evento.key === "Escape") setAberta(false);
    };

    globalThis.addEventListener("keydown", ouvir);
    return () => globalThis.removeEventListener("keydown", ouvir);
  }, []);

  useEffect(() => {
    if (aberta) campo.current?.focus();
  }, [aberta]);

  return (
    <div data-aberta={aberta ? "sim" : "nao"} data-locum-probe="paleta">
      {aberta ? (
        <div
          aria-label={t("palette.label")}
          aria-modal="true"
          className="sem-arrasto fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[20vh]"
          onClick={(evento) => {
            if (evento.target === evento.currentTarget) setAberta(false);
          }}
          role="dialog"
        >
          <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
            <input
              className="w-full bg-transparent px-4 py-3 text-popover-foreground text-sm outline-none placeholder:text-muted-foreground"
              placeholder={t("palette.placeholder")}
              ref={campo}
              type="text"
            />
            <div className="border-border border-t px-4 py-6 text-center text-muted-foreground text-sm">
              {t("palette.empty")}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
