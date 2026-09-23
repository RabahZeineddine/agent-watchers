/**
 * O relógio que bate o agendador enquanto o aplicativo está aberto.
 *
 * O agendador anda por cursor e não sabe que horas são: alguém precisa bater.
 * Até aqui só batiam o evento de acordar do macOS e a linha de comando, e com a
 * máquina ligada o dia inteiro um gatilho vencido ficava vencido até o próximo
 * cochilo. Este relógio fecha esse buraco sem mudar o modelo: ele não decide o
 * que dispara, só pergunta de tempos em tempos, e o cursor de cada gatilho
 * continua sendo quem responde se já é hora.
 *
 * A cadência não precisa acompanhar a do gatilho mais curto. Cada batida também
 * roda a conferência de pull request fechado, que pergunta ao GitHub por até um
 * lote de execuções, e bater a cada minuto gastaria a cota da API para
 * descobrir quase sempre que nada mudou. Cinco minutos de atraso sobre uma
 * cadência de quinze é o preço, e é barato.
 */

export const CADENCIA_DO_RELOGIO_MS = 5 * 60_000;

/**
 * A primeira batida vem logo depois de abrir, e não uma cadência inteira
 * depois. Não na hora exata porque a subida ainda está montando bandeja e
 * janela, e a varredura pode esperar esse meio minuto.
 */
export const PRIMEIRA_BATIDA_MS = 30_000;

export type Batida = () => Promise<void>;

/**
 * Faz uma batida esperar a outra, sem enfileirar.
 *
 * O relógio e o evento de acordar batem o mesmo agendador, e os dois podem cair
 * juntos: o Mac acorda e o temporizador, que estava atrasado pelo sono, dispara
 * no mesmo segundo. Duas batidas simultâneas varreriam o mesmo gatilho duas
 * vezes antes de qualquer uma gravar o cursor. Quem chega com uma batida em
 * andamento recebe a promessa dela: a batida que já está rodando vai ver tudo o
 * que a segunda veria.
 */
export function umaDeCadaVez<A extends unknown[]>(
  bater: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  let emAndamento: Promise<void> | null = null;
  return (...args) => {
    if (emAndamento !== null) return emAndamento;
    emAndamento = bater(...args).finally(() => {
      emAndamento = null;
    });
    return emAndamento;
  };
}

export interface OpcoesDoRelogio {
  cadenciaMs?: number;
  primeiraMs?: number;
  /** Trocável em teste, para avançar o tempo sem esperar por ele. */
  agendar?: (fn: () => void, ms: number) => unknown;
  cancelar?: (handle: unknown) => void;
  /** Para onde vai o erro da batida, que não pode derrubar o processo. */
  aoFalhar?: (err: unknown) => void;
}

export interface Relogio {
  parar(): void;
}

/**
 * Liga o relógio. A próxima batida só é agendada quando a anterior termina, e
 * não num intervalo fixo: uma varredura lenta não empilha outra atrás dela.
 */
export function ligarRelogio(bater: Batida, opcoes: OpcoesDoRelogio = {}): Relogio {
  const cadencia = opcoes.cadenciaMs ?? CADENCIA_DO_RELOGIO_MS;
  const agendar = opcoes.agendar ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelar = opcoes.cancelar ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const aoFalhar = opcoes.aoFalhar ?? ((err) => console.error("relógio: batida falhou", err));

  let parado = false;
  let pendente: unknown = null;

  const proxima = (ms: number): void => {
    if (parado) return;
    pendente = agendar(() => {
      pendente = null;
      void bater()
        .catch(aoFalhar)
        .finally(() => proxima(cadencia));
    }, ms);
  };

  proxima(opcoes.primeiraMs ?? PRIMEIRA_BATIDA_MS);

  return {
    parar() {
      parado = true;
      if (pendente !== null) cancelar(pendente);
      pendente = null;
    },
  };
}
