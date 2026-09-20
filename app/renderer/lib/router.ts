import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Roteamento da janela, por hash.
 *
 * Nao existe servidor por tras do renderer: a pagina e um arquivo no disco,
 * carregado por `file://`. Um caminho escrito pelo History API ate navegaria,
 * mas a primeira recarga pediria ao sistema de arquivos um
 * `dist/renderer/agents` que nunca existiu. O hash fica fora do caminho, entao
 * recarregar, abrir por deep link e voltar pelo historico levam todos ao mesmo
 * lugar sem nada atras respondendo.
 */

/** O hash cru vira identificador de rota, ou o padrao quando nao for nenhuma. */
function lerHash<Id extends string>(ids: readonly Id[], padrao: Id): Id {
  const bruto = globalThis.location?.hash.replace(/^#\/?/, "") ?? "";
  return (ids as readonly string[]).includes(bruto) ? (bruto as Id) : padrao;
}

/**
 * Devolve a rota ativa e a funcao que navega.
 *
 * Navegar escreve o hash e deixa o `hashchange` mandar de volta, em vez de
 * gravar o estado direto: assim o caminho e o mesmo para clique na barra,
 * botao de voltar e URL digitada, e a tela nunca discorda da barra de
 * endereco.
 */
export function useRota<Id extends string>(
  ids: readonly Id[],
  padrao: Id,
): { ativa: Id; navegar: (id: Id) => void } {
  const [ativa, setAtiva] = useState<Id>(() => lerHash(ids, padrao));

  // O catalogo entra por valor, pelo mesmo motivo do `useRead`: quem chama
  // passa a lista literal, que muda de referencia a cada render, e comparar
  // por identidade trocaria o ouvinte de `hashchange` sem necessidade.
  const chave = ids.join(",");
  const catalogo = useRef(ids);
  catalogo.current = ids;

  useEffect(() => {
    const ouvir = () => setAtiva(lerHash(catalogo.current, padrao));
    // A primeira leitura acontece antes do ouvinte existir, e o hash pode ter
    // mudado no meio. Reler aqui fecha essa fresta.
    ouvir();
    globalThis.addEventListener("hashchange", ouvir);
    return () => globalThis.removeEventListener("hashchange", ouvir);
  }, [chave, padrao]);

  const navegar = useCallback((id: Id) => {
    globalThis.location.hash = `#/${id}`;
  }, []);

  return { ativa, navegar };
}
