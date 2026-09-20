import i18next, { type i18n as Instancia } from "i18next";
import en from "../locales/en.json";
import ptBR from "../locales/pt-BR.json";

/**
 * O i18next do processo principal, sem React.
 *
 * O que a janela e a bandeja compartilham é o par de arquivos em `app/locales`,
 * e não o módulo que monta a instância: o da janela puxa o `react-i18next`
 * junto, que não tem o que fazer aqui e arrastaria o React inteiro para dentro
 * do `dist/main.cjs`. Os dicionários entram como fonte porque o esbuild
 * empacota o processo principal num arquivo só, e ler JSON do disco em tempo
 * de execução exigiria um passo de cópia e um caminho que muda entre rodar do
 * repositório e rodar de app empacotado.
 */
const RECURSOS = {
  en: { translation: en },
  "pt-BR": { translation: ptBR },
};

export const IDIOMA_BASE = "en";

let instancia: Instancia | null = null;

export interface Opcoes {
  idioma: string;
  /**
   * Fora de app empacotado, chave ausente estoura. Na bandeja e na notificação
   * o texto cru não aparece numa tela que alguém esteja olhando enquanto
   * desenvolve: ele sai na barra do sistema, onde tradução esquecida passa
   * despercebida por semanas.
   */
  estrito: boolean;
}

/** Monta a instância do processo principal. Idempotente por subida. */
export function iniciarI18n({ idioma, estrito }: Opcoes): Instancia {
  const nova = i18next.createInstance();

  void nova.init({
    resources: RECURSOS,
    lng: idioma,
    fallbackLng: IDIOMA_BASE,
    // Sem isto o i18next adia o fim do init para o próximo tique do laço de
    // eventos, e a bandeja que é montada na linha seguinte sairia sem texto.
    initAsync: false,
    // O plural sai do Intl.PluralRules pelos sufixos `_one` e `_other`, como na
    // janela. O `_zero` é caso à parte do i18next, e serve à bandeja: fila
    // vazia é outra frase, não outra forma de plural.
    compatibilityJSON: "v4",
    // Aqui não há React para escapar nada depois, e o destino é menu nativo e
    // notificação do sistema, que recebem texto puro.
    interpolation: { escapeValue: false },
    returnNull: false,
    saveMissing: estrito,
    missingKeyHandler: (_idiomas, _espaco, chave) => {
      throw new Error(`chave de tradução ausente: ${chave}`);
    },
  });

  instancia = nova;
  return nova;
}

/** O idioma que o processo principal está falando agora. */
export function idiomaAtual(): string {
  return instancia?.language ?? IDIOMA_BASE;
}

/** Troca o idioma sem derrubar nada: o próximo texto montado já sai no novo. */
export async function aplicarIdioma(idioma: string): Promise<void> {
  if (instancia === null) throw new Error("aplicarIdioma antes de iniciarI18n");
  await instancia.changeLanguage(idioma);
}

/**
 * O texto de uma chave do dicionário.
 *
 * Estoura quando ninguém iniciou o i18n em vez de devolver a chave crua: texto
 * que sai antes da subida do dicionário é erro de ordem na subida, e a bandeja
 * mostrando `tray.open` é justamente o que ninguém repara.
 */
export function t(chave: string, vars: Record<string, unknown> = {}): string {
  if (instancia === null) throw new Error(`texto pedido antes do i18n subir: ${chave}`);
  return instancia.t(chave, vars);
}
