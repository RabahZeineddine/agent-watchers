/**
 * Comparacao de texto linha a linha, para a tela de agents.
 *
 * Duas versoes de um spec sao dois JSON com a mesma forma, e a pergunta que a
 * tela responde e "o que mudou daqui para ali". Comparar objeto por objeto
 * daria uma arvore de diferencas mais fiel, mas a versao gravada ja e texto
 * normalizado pelo zod, com a mesma ordem de chave nas duas pontas, entao a
 * linha e uma unidade honesta e cabe num arquivo.
 *
 * Nada de pacote: o algoritmo e a subsequencia comum mais longa, que e curto o
 * bastante para morar aqui e nao arrasta dependencia para dentro da janela.
 */

export type TipoDaLinha = "igual" | "saiu" | "entrou";

export interface LinhaDoDiff {
  tipo: TipoDaLinha;
  texto: string;
  /** Numero da linha no lado antigo, ou nulo quando ela so existe no novo. */
  antes: number | null;
  /** Numero da linha no lado novo, ou nulo quando ela so existe no antigo. */
  depois: number | null;
}

/**
 * Tamanho da maior subsequencia comum entre cada sufixo dos dois lados.
 *
 * A tabela e construida de tras para frente porque a leitura depois caminha
 * para a frente: assim a decisao em cada passo olha o que ainda falta, e a
 * saida sai na ordem em que as linhas aparecem.
 */
function tabela(a: string[], b: string[]): number[][] {
  const t: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
    }
  }

  return t;
}

/** As duas listas de linhas, alinhadas, na ordem em que aparecem. */
export function diffLinhas(antes: string[], depois: string[]): LinhaDoDiff[] {
  const t = tabela(antes, depois);
  const saida: LinhaDoDiff[] = [];
  let i = 0;
  let j = 0;

  while (i < antes.length && j < depois.length) {
    if (antes[i] === depois[j]) {
      saida.push({ tipo: "igual", texto: antes[i]!, antes: i + 1, depois: j + 1 });
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
      saida.push({ tipo: "saiu", texto: antes[i]!, antes: i + 1, depois: null });
      i++;
    } else {
      saida.push({ tipo: "entrou", texto: depois[j]!, antes: null, depois: j + 1 });
      j++;
    }
  }

  for (; i < antes.length; i++) {
    saida.push({ tipo: "saiu", texto: antes[i]!, antes: i + 1, depois: null });
  }
  for (; j < depois.length; j++) {
    saida.push({ tipo: "entrou", texto: depois[j]!, antes: null, depois: j + 1 });
  }

  return saida;
}

/**
 * O diff de dois valores, ja serializados.
 *
 * O JSON sai indentado de proposito: numa linha so, qualquer mudanca viraria
 * "a linha inteira trocou" e o diff nao diria nada.
 */
export function diffJson(antes: unknown, depois: unknown): LinhaDoDiff[] {
  return diffLinhas(
    JSON.stringify(antes, null, 2).split("\n"),
    JSON.stringify(depois, null, 2).split("\n"),
  );
}

/**
 * So o que mudou, com algumas linhas de contexto em volta.
 *
 * Spec inteiro tem centenas de linhas e quase todas sao iguais: mostrar tudo
 * esconderia a diferenca no meio do resto, que e justamente o que a tela
 * precisa apontar.
 */
export function comContexto(linhas: LinhaDoDiff[], contexto = 3): LinhaDoDiff[] {
  const perto = new Set<number>();

  linhas.forEach((linha, i) => {
    if (linha.tipo === "igual") return;
    for (let k = i - contexto; k <= i + contexto; k++) {
      if (k >= 0 && k < linhas.length) perto.add(k);
    }
  });

  return linhas.filter((_, i) => perto.has(i));
}
