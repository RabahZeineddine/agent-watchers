import { z } from "zod";
import { settingsService, type SettingsService } from "./settings-service.js";

/** Onde o cadastro inteiro mora. Uma chave só, porque ele é lido e gravado junto. */
const CHAVE = "slack.watch";

/**
 * Ferramenta e nomes de argumento de estreia.
 *
 * São os do servidor MCP de Slack mais comum, e não uma regra: o campo existe
 * justamente porque um outro chama o canal de `channel` e a janela de `since`.
 * Deixar o formulário em branco obrigaria quem cadastra a descobrir três nomes
 * antes de observar o primeiro canal.
 */
export const SLACK_TOOL_PADRAO = "conversations_history";
export const SLACK_CHANNEL_ARG_PADRAO = "channel_id";
export const SLACK_SINCE_ARG_PADRAO = "oldest";

/**
 * Quantas mensagens a consulta pede por canal a cada batida.
 *
 * Teto, e não meta: o que limita de verdade é o cursor, que só deixa passar o
 * que chegou desde a última varredura. Existe para que a primeira varredura de
 * um canal antigo não puxe o histórico inteiro de uma vez.
 */
export const SLACK_LIMITE_PADRAO = 50;

/**
 * Ferramenta e argumentos da resposta, também de estreia.
 *
 * São outros que os da leitura de propósito: a ferramenta que lista histórico
 * costuma chamar o canal de `channel_id`, e a que publica chama de `channel`.
 * Guardar um nome só para os dois faria a resposta sair com o canal no campo
 * errado no dia em que alguém clicasse.
 *
 * Cadastrar não publica nada. Isto aqui só diz por onde a resposta sairia
 * depois que uma pessoa tivesse clicado nela na fila.
 */
export const SLACK_POST_TOOL_PADRAO = "chat_postMessage";
export const SLACK_POST_CHANNEL_ARG_PADRAO = "channel";
export const SLACK_TEXT_ARG_PADRAO = "text";
export const SLACK_THREAD_ARG_PADRAO = "thread_ts";

const SlackWatchSchema = z.object({
  /** Servidor MCP de Slack cadastrado, ou nulo enquanto ninguém escolheu. */
  server: z.string().min(1).nullable().default(null),
  tool: z.string().min(1).default(SLACK_TOOL_PADRAO),
  /** Nome do argumento que recebe o canal. */
  channelArg: z.string().min(1).default(SLACK_CHANNEL_ARG_PADRAO),
  /** Nome do argumento que recebe a janela de tempo. */
  sinceArg: z.string().min(1).default(SLACK_SINCE_ARG_PADRAO),
  limit: z.number().int().min(1).max(1000).default(SLACK_LIMITE_PADRAO),
  /** Ferramenta que responde em thread, e os nomes dos argumentos dela. */
  postTool: z.string().min(1).default(SLACK_POST_TOOL_PADRAO),
  postChannelArg: z.string().min(1).default(SLACK_POST_CHANNEL_ARG_PADRAO),
  textArg: z.string().min(1).default(SLACK_TEXT_ARG_PADRAO),
  threadArg: z.string().min(1).default(SLACK_THREAD_ARG_PADRAO),
  /** Canais observados, pelo identificador que o Slack usa. */
  channels: z.array(z.string().min(1)).default([]),
});

export type SlackWatch = z.infer<typeof SlackWatchSchema>;
/** O que se passa para cadastrar a origem, antes dos defaults do zod. */
export type SlackSourceInput = z.input<typeof SlackWatchSchema>;

/** Um cadastro que não observa nada, que é como toda máquina começa. */
export const SLACK_SEM_CADASTRO: SlackWatch = SlackWatchSchema.parse({});

/**
 * O que esta máquina observa no Slack.
 *
 * Não existe token de Slack aqui, e não é esquecimento: quem fala com o Slack
 * é o servidor MCP que alguém já autorizou, e o Locum só sabe o nome dele. Um
 * token próprio seria uma segunda credencial para a mesma conversa, com um
 * segundo lugar de onde ela poderia vazar.
 *
 * O cadastro mora em `settings` e não em tabela própria porque é um só por
 * máquina: um servidor, uma ferramenta e a lista de canais. Tabela daria
 * migração e chave estrangeira para guardar o que cabe num objeto.
 *
 * Nada aqui publica. O cadastro descreve o que ler e por onde uma resposta
 * sairia, e nenhuma das duas coisas acontece por estar cadastrada: responder em
 * thread é passo de ação, e ele para na fila de aprovação como qualquer escrita
 * externa.
 */
export class SlackService {
  constructor(private readonly settings: SettingsService = settingsService) {}

  async get(): Promise<SlackWatch> {
    const bruto = await this.settings.get(CHAVE);
    if (bruto === undefined) return SLACK_SEM_CADASTRO;

    // Cadastro ilegível vira cadastro vazio em vez de derrubar a tela: o que
    // se perde é uma lista de canais que dá para digitar de novo, e o que se
    // ganharia derrubando é uma configuração que não abre mais.
    try {
      const parsed = SlackWatchSchema.safeParse(JSON.parse(bruto));
      return parsed.success ? parsed.data : SLACK_SEM_CADASTRO;
    } catch {
      return SLACK_SEM_CADASTRO;
    }
  }

  /** Qual servidor MCP responde pelo Slack, e como perguntar a ele. */
  async setSource(input: SlackSourceInput): Promise<SlackWatch> {
    const atual = await this.get();
    return this.save(SlackWatchSchema.parse({ ...input, channels: atual.channels }));
  }

  async addChannel(channel: string): Promise<SlackWatch> {
    const atual = await this.get();
    const limpo = channel.trim();
    if (limpo === "") throw new Error("canal sem identificador");
    if (atual.channels.includes(limpo)) return atual;
    return this.save({ ...atual, channels: [...atual.channels, limpo] });
  }

  async removeChannel(channel: string): Promise<SlackWatch> {
    const atual = await this.get();
    return this.save({ ...atual, channels: atual.channels.filter((c) => c !== channel) });
  }

  /** Apaga o cadastro inteiro. O cursor de cada canal não é assunto daqui. */
  async clear(): Promise<void> {
    await this.settings.remove(CHAVE);
  }

  private async save(watch: SlackWatch): Promise<SlackWatch> {
    await this.settings.set(CHAVE, JSON.stringify(watch));
    return watch;
  }
}

export const slackService = new SlackService();
