/**
 * Resposta de ferramenta no formato do protocolo.
 *
 * Erro que sobe de dentro de uma ferramenta viraria falha de transporte, e o
 * cliente so veria "a chamada quebrou". Passando por aqui ele recebe a mensagem
 * como resultado marcado com `isError`, que e o que o modelo do outro lado
 * consegue ler e corrigir sozinho.
 *
 * O registro em si continua em cada ferramenta, e nao num embrulho generico,
 * porque e dali que sai a inferencia de tipo do schema de entrada.
 */
export async function respond(produce: () => Promise<unknown>) {
  try {
    const value = await produce();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}
