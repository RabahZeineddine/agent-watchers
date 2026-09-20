import i18next, { type i18n as Instancia } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../locales/en.json";
import ptBR from "../../locales/pt-BR.json";

/**
 * A instância base do i18next da janela.
 *
 * Os dicionários entram como fonte, e não como arquivo buscado em tempo de
 * execução: a janela carrega de `file://` e não existe servidor atrás dela,
 * então um backend HTTP simplesmente não teria de onde ler. O mesmo par de
 * arquivos serve o processo principal, que monta a própria instância a partir
 * deles, porque lá não há React para carregar junto.
 */
const RECURSOS = {
  en: { translation: en },
  "pt-BR": { translation: ptBR },
};

export const IDIOMA_BASE = "en";

export interface Opcoes {
  idioma: string;
  /**
   * Fora de app empacotado, chave ausente estoura. Mostrar a chave crua na
   * tela é como texto sem tradução chega no usuário sem ninguém perceber.
   */
  estrito: boolean;
}

export function criarI18n({ idioma, estrito }: Opcoes): Instancia {
  const instancia = i18next.createInstance();

  void instancia.use(initReactI18next).init({
    resources: RECURSOS,
    lng: idioma,
    fallbackLng: IDIOMA_BASE,
    // O plural sai do Intl.PluralRules pelos sufixos `_one` e `_other`, que é
    // o que o formato v4 quer dizer. Nenhum componente decide forma de plural:
    // idioma com três ou seis formas não cabe num ternário, e o russo do
    // primeiro usuário estrangeiro apareceria quebrado.
    compatibilityJSON: "v4",
    // O React já escapa o que vai para a tela. Escapar de novo aqui viraria
    // `&amp;` dentro da mensagem de erro que a ponte devolve.
    interpolation: { escapeValue: false },
    returnNull: false,
    saveMissing: estrito,
    missingKeyHandler: (_idiomas, _espaco, chave) => {
      throw new Error(`chave de tradução ausente: ${chave}`);
    },
    // Sem backend, os dicionários já estão prontos no primeiro render. Suspense
    // aqui só criaria um quadro vazio e a exigência de um limite em volta da
    // janela inteira.
    react: { useSuspense: false },
  });

  return instancia;
}
