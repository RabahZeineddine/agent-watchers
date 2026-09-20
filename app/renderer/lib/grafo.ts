/**
 * O arranjo do grafo da execucao, sem nada de React.
 *
 * O React Flow nao posiciona no: ele desenha onde mandarem. Quem manda e esta
 * funcao, e ela mora fora do componente porque arranjo e conta, nao desenho.
 *
 * A dependencia e o que o spec chama de `needs`, e nao a ordem dos passos no
 * banco: dois passos que dependem do mesmo terceiro rodam em sequencia porque
 * o executor e serial, e desenha-los um embaixo do outro e justamente o que
 * mostra que eles nao dependem um do outro.
 */

export interface PassoDoGrafo {
  key: string;
  needs: readonly string[];
}

export interface NoDoGrafo {
  key: string;
  coluna: number;
  x: number;
  y: number;
}

export interface ArestaDoGrafo {
  id: string;
  source: string;
  target: string;
}

export const LARGURA_DO_NO = 232;
export const ALTURA_DO_NO = 108;

const VAO_X = 88;
const VAO_Y = 28;

/**
 * Posiciona cada passo e lista as arestas.
 *
 * A coluna e a maior distancia ate um passo sem dependencia, e nao a menor:
 * com a menor, um passo que depende de dois cairia a esquerda de quem ele
 * espera, e a seta apontaria para tras.
 */
export function montarGrafo(passos: readonly PassoDoGrafo[]): {
  nos: NoDoGrafo[];
  arestas: ArestaDoGrafo[];
} {
  const porChave = new Map(passos.map((p) => [p.key, p]));
  const colunas = new Map<string, number>();

  // O spec que chega aqui ja passou pelo zod, que recusa ciclo. A trilha e
  // defesa mesmo assim: um ciclo que escapasse travaria a janela em vez de
  // desenhar torto, e tela travada nao tem como contar o que houve.
  const coluna = (key: string, trilha: readonly string[]): number => {
    const pronta = colunas.get(key);
    if (pronta !== undefined) return pronta;
    if (trilha.includes(key)) return 0;

    const passo = porChave.get(key);
    const anteriores = (passo?.needs ?? []).filter((n) => porChave.has(n));
    const valor =
      anteriores.length === 0
        ? 0
        : 1 + Math.max(...anteriores.map((n) => coluna(n, [...trilha, key])));

    colunas.set(key, valor);
    return valor;
  };

  const ocupadas = new Map<number, number>();
  const nos = passos.map((passo) => {
    const c = coluna(passo.key, []);
    const linha = ocupadas.get(c) ?? 0;
    ocupadas.set(c, linha + 1);

    return {
      key: passo.key,
      coluna: c,
      x: c * (LARGURA_DO_NO + VAO_X),
      y: linha * (ALTURA_DO_NO + VAO_Y),
    };
  });

  // Dependencia para passo que nao existe no spec nao vira aresta: o React Flow
  // descartaria em silencio e o smoke contaria a mais de um lado so.
  const arestas = passos.flatMap((passo) =>
    passo.needs
      .filter((origem) => porChave.has(origem))
      .map((origem) => ({ id: `${origem}->${passo.key}`, source: origem, target: passo.key })),
  );

  return { nos, arestas };
}
