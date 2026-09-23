# Locum, núcleo da v1

Núcleo headless do aplicativo. A casca Electron entra na fase 5; por enquanto
tudo roda pela linha de comando, com o mesmo executor que a interface vai usar.

## Preparo

```bash
cp .env.example .env    # preencha GITHUB_TOKEN e MACHINE_ID
pnpm install
pnpm db:push
pnpm dev import ../examples/agents/pr-review.json
```

## Revisar um PR

```bash
pnpm dev review owner/repo#123
```

O pipeline roda triagem, auditoria, contexto de deploy (pulado quando o ArgoCD
não estiver cadastrado) e prepara a review. O passo de comentário nasce em modo
rascunho: a review é criada no GitHub em estado pendente, visível apenas para
você, que abre o pull request e envia quando concordar.

Para o modo de aprovação pela fila, mude `mode` do passo `post` para `approve`:

```bash
pnpm dev inbox
pnpm dev approve <id>
```

## Varredura

```bash
pnpm dev poll 'time/.*'
pnpm dev resume
```

A varredura usa cursor de tempo, não intervalo fixo, então uma janela perdida
com a máquina dormindo é recuperada na próxima execução. O índice único de
evento impede que o mesmo commit seja revisado duas vezes.

## Máquina sem assinatura

Os passos declaram modelos concretos do runtime `claude-code`. Numa máquina sem
o binário do Claude Code, a tabela `model_fallbacks` redireciona para os modelos
por chave de API. A definição do agent não muda.

## Estrutura

```
src/
  db/          schema e conexão SQLite
  config/      AgentSpec em zod, herança de ferramentas, ordenação topológica
  providers/   registro de provedores e resolução de fallback
  mcp/         servidores sob demanda, encerrados após ocioso
  runtimes/    native (AI SDK) e claude-code (assinatura)
  executor/    máquina de estado durável e orçamento
  approval/    porta única de saída
  sources/     GitHub: ingestão determinística e ação de review
  skills/      descoberta no acervo e seleção por regra de arquivo
```
