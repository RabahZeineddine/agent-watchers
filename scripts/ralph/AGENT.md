# Locum, iteração do loop

Você está construindo o Locum, um aplicativo pessoal para macOS. O desenho está
em `docs/adr/`. Leia `docs/estado-atual.md` para saber o que já existe.

Esta é **uma iteração**. Você é uma instância nova: não lembra da anterior. O
estado está nos arquivos e no git.

## O que fazer agora

1. Ler `scripts/ralph/prd.json`.
2. Pegar a story de **menor `priority`** com `passes: false` e `blocked: false`.
3. Implementar **apenas essa story**.
4. Rodar o comando em `verify`, a partir de `app/`.
5. Passou: marcar `"passes": true` na story, anexar uma linha em
   `scripts/ralph/progress.txt`, e commitar tudo.
6. Não passou depois de tentar corrigir: marcar `"blocked": true`, escrever o
   motivo num campo `"blocked_reason"`, anexar a linha no progresso, commitar
   isso e parar.

Uma story por iteração. Não adiante a próxima.

## Regras

**Nunca fazer push.** Commit local apenas. O push é decisão do dono do
repositório, e o script aborta se detectar a branch no remoto.

**Nunca publicar para fora.** Proibido rodar `approve`, proibido chamar API de
escrita do GitHub, proibido rodar `review` contra repositório real. Para
exercitar o executor use `npx tsx src/cli.ts demo`, que usa evento sintético.

**Nunca implementar aprovação no servidor MCP.** `approve`, `reject` e qualquer
publicação ficam fora, por decisão do ADR 0002. Story que pareça pedir isso é
para marcar como bloqueada, não para cumprir.

**Cota.** O `demo` gasta alguns minutos de assinatura. No máximo uma execução
por iteração, e só quando a story tocar executor, runtime ou registro MCP. O
resto verifica com `npx tsc --noEmit`, que é de graça.

**Árvore limpa no fim.** Commit tudo que você mexeu. A próxima iteração é uma
instância nova e não sabe o que ficou pela metade. O script aborta com árvore
suja.

**Sem segredo.** Nada de token, chave ou credencial em código, teste ou
documentação.

**Escrita em português, sem travessão.** Comentário, commit e documentação em
prosa normal. Sem assinatura de IA no commit, sem `Co-Authored-By`, sem rodapé
de atribuição.

**Comentário só onde o porquê não é óbvio.** O padrão do repositório é explicar
decisão e armadilha, não narrar o que a linha faz.

**Electron, no marco M3.** A verificação é sempre por `--smoke`, que sobe sem
mostrar janela e sai com código 0. Não tente abrir interface gráfica: o loop
roda sem ninguém olhando e uma janela aberta trava a iteração. Se a story
parecer exigir interação visual, marque bloqueada.

**A ponte e o keychain não abrem exceção.** Nada que você escrever pode permitir
publicar sem o clique de uma pessoa, e segredo nunca entra em banco, log ou
arquivo solto. A emenda 6 do ADR 0002 explica por que a regra é "nada sai sem
uma pessoa ter dito que sai", e não "não existe ferramenta de aprovar".

**Serviço primeiro.** Regra de cadastro mora em `app/src/services/`. Linha de
comando, servidor MCP e interface são casca fina. Se você está escrevendo regra
dentro do `cli.ts`, está no lugar errado.

## Formato do commit

```
feat: extrai AgentService da linha de comando

A gravação de versão de agent passa a viver no serviço, porque linha de
comando, servidor MCP e interface vão precisar da mesma regra.
```

## Formato do progresso

Uma linha por iteração em `scripts/ralph/progress.txt`:

```
2026-09-19  M1.1  feito      AgentService extraido, tsc limpo
2026-09-19  M1.2  bloqueado  tabela mcp_servers sem coluna para env do processo
```
