# Prompt do loop

Você está construindo o Agent Watchers, um aplicativo pessoal para macOS
descrito em `docs/adr/0001-arquitetura-v2.md` e `docs/adr/0002-camada-de-servico-e-servidor-mcp.md`.

Todos os comandos de verificação rodam a partir de `app/`. A documentação fica
na raiz, em `docs/`.

## O que fazer nesta iteração

1. Ler `docs/backlog.md` e pegar **a primeira tarefa não marcada**.
2. Ler `docs/estado-atual.md` para saber o que já existe.
3. Implementar **apenas essa tarefa**.
4. Rodar o comando de verificação que a tarefa declara.
5. Passou: marcar `[x]` no backlog, anexar uma linha em `docs/diario.md` e
   commitar.
6. Não passou: não marcar. Anexar em `docs/diario.md` o que falhou e parar.

Uma tarefa por iteração. Sem adiantar a próxima.

## Regras

**Não fazer push.** Commit local apenas. O push é decisão do dono do repositório.

**Não publicar nada para fora.** Nunca rodar `npx tsx src/cli.ts approve`, nunca
chamar a API do GitHub para criar review, comentário, issue ou qualquer escrita.
Nunca rodar `npx tsx src/cli.ts review` contra repositório real. Para exercitar
o executor use `npx tsx src/cli.ts demo`, que usa evento sintético.

**Não implementar aprovação no servidor MCP.** `approve`, `reject` e publicação
ficam fora por decisão de arquitetura, registrada no ADR 0002. Se uma tarefa
parecer pedir isso, parar e escrever no diário.

**Cuidado com cota.** O `demo` gasta alguns minutos de assinatura por execução.
Rodar no máximo uma vez por iteração, e só quando a tarefa tocar o executor, os
runtimes ou o registro MCP. Tarefa que mexe só em serviço ou tipo verifica com
`npx tsc --noEmit`.

**Verificação de tipos sempre.** `npx tsc --noEmit` precisa passar limpo antes
de qualquer commit, em toda tarefa.

**Sem segredo no repositório.** Nada de token, chave ou credencial em código,
teste ou documentação. `.env` continua fora do git.

**Escrita em português, sem travessão.** Comentário de código, mensagem de
commit e documentação em prosa normal. Sem assinatura de IA na mensagem de
commit, sem `Co-Authored-By`, sem rodapé de atribuição.

**Comentário só onde o porquê não é óbvio pelo código.** O padrão do
repositório é explicar decisão e armadilha, não narrar o que a linha faz.

## Formato do commit

Tipo convencional, escopo opcional, corpo explicando a decisão quando houver
uma. Exemplo:

```
feat: extrai AgentService da linha de comando

A gravação de versão de agent passa a viver no serviço, porque linha de
comando, servidor MCP e interface vão precisar da mesma regra.
```

## Formato do diário

Uma linha por iteração em `docs/diario.md`:

```
2026-09-19  M1.1  feito      AgentService extraído, tsc limpo
2026-09-19  M1.2  bloqueado  tabela mcp_servers sem coluna para env do processo
```

## Quando parar o loop

- tarefa bloqueada por decisão que só o dono do repositório pode tomar
- verificação falhando duas iterações seguidas na mesma tarefa
- backlog do marco atual todo marcado
