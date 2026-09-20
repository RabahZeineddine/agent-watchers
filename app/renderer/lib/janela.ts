import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Janela de rolagem para lista longa de linhas de mesma altura.
 *
 * Escrito a mao, e nao trazido de pacote, porque o que a tela de execucoes
 * precisa cabe em trinta linhas: as linhas tem altura fixa, entao o indice da
 * primeira visivel e uma divisao, e nao ha medicao nenhuma para fazer. Um
 * virtualizador de verdade ganha quando a altura varia, que nao e o caso aqui.
 *
 * O motivo de existir e CPU: um historico de execucoes cresce sem parar, e
 * redesenhar mil linhas a cada quadro de rolagem aquece a maquina a toa.
 */
export interface Janela {
  /** Vai no elemento que rola. */
  ref: (no: HTMLElement | null) => void;
  /** Indice da primeira linha desenhada. */
  inicio: number;
  /** Indice logo depois da ultima desenhada. */
  fim: number;
  /** Altura do espacador de cima, em pixels. */
  antes: number;
  /** Altura do espacador de baixo, em pixels. */
  depois: number;
}

export function useJanela(
  total: number,
  alturaDaLinha: number,
  folga = 6,
): Janela {
  const [rolagem, setRolagem] = useState(0);
  const [altura, setAltura] = useState(0);
  const no = useRef<HTMLElement | null>(null);

  const medir = useCallback(() => {
    const alvo = no.current;
    if (alvo === null) return;
    setRolagem(alvo.scrollTop);
    setAltura(alvo.clientHeight);
  }, []);

  // Callback ref, e nao objeto: o elemento que rola so existe depois que a
  // tela decidiu se mostra a lista ou uma mensagem, e um efeito com `ref.current`
  // na dependencia nao acorda quando ele aparece.
  const ref = useCallback(
    (alvo: HTMLElement | null) => {
      no.current = alvo;
      if (alvo !== null) medir();
    },
    [medir],
  );

  useEffect(() => {
    const alvo = no.current;
    if (alvo === null) return;

    alvo.addEventListener("scroll", medir, { passive: true });
    const observador = new ResizeObserver(medir);
    observador.observe(alvo);
    return () => {
      alvo.removeEventListener("scroll", medir);
      observador.disconnect();
    };
  }, [medir, total]);

  // Sem altura medida ainda, desenha a folga e deixa o primeiro quadro
  // corrigir: zero linha faria a lista piscar vazia na entrada.
  const visiveis = altura > 0 ? Math.ceil(altura / alturaDaLinha) : folga;
  const inicio = Math.max(0, Math.floor(rolagem / alturaDaLinha) - folga);
  const fim = Math.min(total, inicio + visiveis + folga * 2);

  return {
    ref,
    inicio,
    fim,
    antes: inicio * alturaDaLinha,
    depois: Math.max(0, (total - fim) * alturaDaLinha),
  };
}
