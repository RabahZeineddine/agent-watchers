import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { I18nextProvider } from "react-i18next";
import type { i18n as Instancia } from "i18next";
import { call, read } from "@/lib/bridge";
import { criarI18n } from "@/lib/i18n";
import type { WindowLanguage } from "../../electron/bridge-contract.js";
import type { Language } from "../../src/services/i18n-service.js";

export interface Idioma extends WindowLanguage {
  /** `null` devolve a escolha ao sistema, que não é o mesmo que escolher `en`. */
  trocar: (idioma: Language | null) => Promise<void>;
}

const Contexto = createContext<Idioma | null>(null);

export function useIdioma(): Idioma {
  const valor = useContext(Contexto);
  if (valor === null) throw new Error("useIdioma foi chamado fora do provedor de idioma");
  return valor;
}

/**
 * Resolve o idioma antes de a janela desenhar qualquer coisa.
 *
 * A etiqueta do sistema só existe do lado do Electron, então a primeira coisa
 * que a janela faz é perguntar pela ponte. Nada é desenhado enquanto a resposta
 * não chega, de propósito: montar no idioma base e corrigir depois faria a tela
 * piscar em inglês em toda subida de quem escolheu português.
 *
 * Trocar de idioma depois não remonta a instância. É a mesma instância que muda
 * de idioma, porque recriá-la desmontaria a árvore inteira e jogaria fora a
 * rolagem, o destino ativo e o que estiver aberto na tela.
 */
export function ProvedorDeIdioma({ children }: { children: React.ReactNode }) {
  const [estado, setEstado] = useState<WindowLanguage | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const instancia = useRef<Instancia | null>(null);

  // A instância nasce com o idioma já resolvido, e não com o base: o `lng` do
  // init é o que o primeiro render enxerga, e `changeLanguage` depois dele
  // chegaria tarde demais para o quadro inicial.
  if (estado !== null && instancia.current === null) {
    instancia.current = criarI18n({ idioma: estado.language, estrito: estado.strict });
  }

  useEffect(() => {
    let vivo = true;
    read("i18n.state").then(
      (novo) => {
        if (vivo) setEstado(novo);
      },
      (falha: unknown) => {
        if (vivo) setErro(falha instanceof Error ? falha.message : String(falha));
      },
    );
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    if (estado === null || instancia.current === null) return;
    void instancia.current.changeLanguage(estado.language);
    // O atributo do documento serve leitor de tela e separação silábica, que
    // não enxergam o estado do React.
    document.documentElement.lang = estado.language;
  }, [estado]);

  const trocar = useCallback(async (idioma: Language | null) => {
    setEstado(await call("i18n.setPreference", idioma));
  }, []);

  const valor = useMemo<Idioma | null>(
    () => (estado === null ? null : { ...estado, trocar }),
    [estado, trocar],
  );

  if (erro !== null) {
    // A única frase da janela que não passa pelo dicionário, e não tem como
    // passar: sem idioma resolvido não há dicionário para consultar.
    return <div data-locum-probe="idioma-erro">{erro}</div>;
  }

  if (valor === null || instancia.current === null) return null;

  return (
    <I18nextProvider i18n={instancia.current}>
      <Contexto.Provider value={valor}>
        {/*
          Marcador do smoke, que roda sem ninguém olhando e precisa comparar o
          idioma que a janela aplicou com o que os serviços resolveram.
        */}
        <span
          className="hidden"
          data-estrito={String(valor.strict)}
          data-idioma={valor.language}
          data-locum-probe="idioma"
          data-preferencia={valor.preference ?? ""}
          data-sistema={valor.system}
        />
        {children}
      </Contexto.Provider>
    </I18nextProvider>
  );
}
