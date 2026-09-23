import prReview from "../../../examples/agents/pr-review.json";
import slackDigest from "../../../examples/agents/slack-digest.json";
import slackReply from "../../../examples/agents/slack-reply.json";
import { AgentSpec } from "../config/types.js";

/**
 * Os agents de exemplo, lidos de `examples/agents/` na raiz do repositório.
 *
 * O Locum não traz agent de fábrica: o banco nasce vazio e cada pessoa importa
 * os seus. Estes arquivos são o que alguém importaria para começar, e moram fora
 * do app para deixar isso claro. Entram aqui só para os testes, as fumaças e o
 * `demo` da linha de comando, que precisam de um agent conhecido; nada neste
 * módulo grava no banco de ninguém.
 *
 * Passar pelo `AgentSpec.parse` na carga faz o exemplo quebrado falhar no
 * teste, e não na mão de quem o importou.
 */
export const prReviewSpec = AgentSpec.parse(prReview);
export const slackDigestSpec = AgentSpec.parse(slackDigest);
export const slackReplySpec = AgentSpec.parse(slackReply);
