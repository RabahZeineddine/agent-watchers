import { Bot, Inbox as InboxIcon, ListTree, Settings } from "lucide-react";
import type { ComponentType } from "react";
import { Agents } from "./telas/agents";
import { Configuracao } from "./telas/configuracao";
import { Execucoes } from "./telas/execucoes";
import { Inbox } from "./telas/inbox";

/**
 * O que uma tela recebe do layout.
 *
 * O detalhe sai do roteador do layout, e nao de um `useRota` dentro de cada
 * tela: o ouvinte de `hashchange` e um so e a tela recebe o que ele leu. Dois
 * ouvintes discordariam por um quadro na troca de destino.
 */
export interface TelaProps {
  /** O que veio depois do destino no hash, ou nulo. */
  detalhe: string | null;
  navegar: (id: RotaId, detalhe?: string) => void;
}

/**
 * Os quatro destinos da janela, na ordem em que aparecem na barra lateral.
 *
 * A lista e escrita a mao, e e a unica fonte tanto da barra quanto do hash:
 * destino novo se acrescenta aqui e aparece nos dois lugares, sem chance de a
 * barra oferecer rota que nao existe nem de existir rota que a barra esconde.
 */
export const ROTAS = [
  { id: "inbox", titulo: "Inbox", icone: InboxIcon, Tela: Inbox },
  { id: "execucoes", titulo: "Execucoes", icone: ListTree, Tela: Execucoes },
  { id: "agents", titulo: "Agents", icone: Bot, Tela: Agents },
  { id: "configuracao", titulo: "Configuracao", icone: Settings, Tela: Configuracao },
] as const satisfies readonly {
  id: string;
  titulo: string;
  icone: ComponentType<{ className?: string }>;
  Tela: ComponentType<TelaProps>;
}[];

export type RotaId = (typeof ROTAS)[number]["id"];

/** O padrao com hash vazio. A fila e o que importa primeiro ao abrir o Locum. */
export const ROTA_PADRAO: RotaId = "inbox";

/**
 * Identificadores soltos, para o roteador. Const de modulo de proposito: a
 * lista entra numa dependencia de efeito e montar outra a cada render trocaria
 * o ouvinte de `hashchange` a toa.
 */
export const ROTA_IDS: readonly RotaId[] = ROTAS.map((rota) => rota.id);
