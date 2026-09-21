# A primeira execução real

Até aqui o Locum foi verificado com evento sintético: o `demo` monta um pull
request de mentira e o pipeline roda sem encostar em nada de fora. Este
documento é o outro lado, o de ligar o aplicativo num repositório de verdade
pela primeira vez.

Os passos estão na ordem em que alguém os faria. Vale a pena ler até o fim antes
de criar o token, porque o penúltimo passo explica por que a primeira varredura
pode não acontecer sozinha.

Uma coisa antes de tudo, porque muda como se lê o resto: **o passo que comenta
no GitHub nasce em modo aprovação**. O Locum lê, pensa, monta o comentário e
para. Nada aparece no pull request de ninguém enquanto você não clicar em
aprovar, na fila. A última seção detalha o que garante isso.

## Antes de começar

Três coisas precisam estar no lugar. Nenhuma delas é o token.

**O aplicativo instalado ou o repositório pronto para rodar.** Pelo `.dmg`, o
caminho está em [empacotamento.md](empacotamento.md). Em desenvolvimento, `npm
run start` dentro de `app/` constrói e sobe a mesma coisa.

**O agent semente gravado no banco.** A interface lê agents, não cria: a tela de
repositórios observados precisa de pelo menos um agent na lista para deixar
salvar, e num banco recém-criado essa lista está vazia. A gravação é pela linha
de comando, uma vez:

```bash
cd app
npm run dev seed
```

O banco fica em `~/Library/Application Support/locum/watchers.db`, fora do
repositório, e é o mesmo para o aplicativo empacotado e para a linha de comando.
Semear pelo terminal e abrir o `Locum.app` depois funciona: é o mesmo arquivo.

**Um runtime que saiba executar os passos.** O agent semente pede
`claude-code/claude-sonnet-5` na triagem e `claude-code/claude-opus-5` na
auditoria, que gastam a sua assinatura pelo binário do Claude Code já
autenticado na máquina. Sem esse binário, cadastre uma substituição de modelo na
seção de provedores da configuração, apontando esses dois para um provedor por
chave de API. A tela de provedores mostra quais estão disponíveis nesta máquina.

## 1. Criar o token com as permissões mínimas

O token sai de [github.com/settings/tokens](https://github.com/settings/tokens),
na sua conta. Ele é pessoal: o Locum observa com a sua identidade, e o que ele
vier a publicar sai assinado por você.

**Token clássico**, que é o caminho mais previsível para observar uma
organização inteira:

| escopo | para quê |
|---|---|
| `repo` | ler o pull request, o diff e os comentários |
| `read:org` | a busca por `org:<dono>`, que é como a varredura acha os PRs abertos |

**Token de escopo fino**, se você prefere permissão por repositório:

| permissão | nível |
|---|---|
| Metadata | leitura |
| Contents | leitura |
| Pull requests | leitura |
| Pull requests | escrita, só se quiser que o Locum comente |

A escrita em Pull requests é a única permissão que o Locum usa para sair. Ela
não dispensa a aprovação: sem ela o clique de aprovar falha na hora de publicar,
com ela o clique continua sendo necessário. Se a sua intenção é só ver o que o
Locum acharia, crie o token sem escrita e conceda depois.

Vale saber de uma limitação antes de escolher: a varredura usa a busca do
GitHub, e a busca com token de escopo fino só enxerga os repositórios que o
token alcança. Para observar uma organização inteira por padrão de nome, o
clássico com `read:org` é o que responde o esperado.

Nada de colocar esse token em arquivo do repositório, em variável de ambiente
comitada ou em script. O lugar dele é o passo seguinte.

## 2. Guardar o token pela interface

Abra a configuração e vá até **Credencial do GitHub**. Cole o token no campo e
clique em **guardar**.

O que acontece: o valor vai para o keychain do macOS, sob a referência
`source/github`, e o campo é limpo antes mesmo da resposta chegar. A tela nunca
mostra o token de volta. O que ela mostra é a referência, se existe algo
guardado nela, e se este processo alcança o keychain.

Clique em **conferir**. O Locum pergunta ao GitHub de quem é o token e escreve
na tela o login e os escopos, com a data da conferência. É a única maneira de
saber que você colou o token certo antes de descobrir isso numa varredura que
não acha nada.

Duas leituras que a tela faz e que confundem à primeira vista:

**"escopo fino, permissão por repositório"** no lugar da lista de escopos não é
erro. Token clássico publica os escopos num cabeçalho da resposta; token de
escopo fino não publica nenhum, porque a permissão dele não cabe numa lista de
palavras. Lista vazia ali quer dizer que não há o que listar, e não que o token
não pode nada.

**"há GITHUB_TOKEN no ambiente"** avisa que existe um caminho de trás. O cofre
vem primeiro: se houver token guardado, é ele que a varredura usa, mesmo com a
variável definida no shell de onde o app subiu. A variável continua valendo para
a linha de comando, onde não há keychain.

Trocar o token depois apaga o login e os escopos da conferência anterior, de
propósito. Eles descreviam o token antigo, e mantê-los faria a tela afirmar, com
cara de dado conferido, uma conta que o token novo pode nem ter. Depois de
trocar, confira de novo.

## 3. Escolher o repositório

Ainda na configuração, a seção **Repositórios observados**. São quatro campos:

**O agent que vai revisar.** Depois do `seed`, `pr-review` é o único, e já vem
escolhido.

**O dono**, que é o login da organização ou da conta. É o `org:` da busca.

**O padrão do nome do repositório**, que é uma expressão regular aplicada ao
nome completo. `^meu-servico$` pega um repositório só. `api-` pega todos que
tenham isso no nome. Comece por um repositório só: a primeira varredura é a hora
de descobrir que o padrão pega mais coisa do que você pensava, e descobrir isso
com um repositório custa menos.

**A cadência em minutos**, que é de quanto em quanto tempo aquele gatilho se
considera vencido.

Clique em **observar**. A linha aparece na lista marcada como **parado**, e é
isso mesmo: cadastrar não liga nada.

## 4. Habilitar o gatilho

Na linha que acabou de aparecer, clique em **ligar**.

Esse é o segundo clique, e ele existe porque cadastrar e começar a gastar são
decisões diferentes. Um gatilho recém-ligado que nunca disparou já está vencido:
ele não espera uma cadência inteira para a primeira batida, porque esperar sem
que ninguém tenha pedido seria só demora.

A linha passa a mostrar a última varredura e a próxima. Enquanto não houver
varredura nenhuma, a última aparece como "nunca".

## 5. O que esperar na primeira varredura

Aqui está a parte que surpreende, e é melhor saber antes: **o agendador não tem
relógio próprio**. Ele anda por cursor de tempo e é batido de fora. Hoje quem
bate é o evento de energia do macOS, quando a máquina acorda, e a batida manual:

```bash
cd app
npm run dev tick          # uma batida nos gatilhos vencidos
npm run dev tick --wait   # o mesmo, esperando as execuções terminarem
npm run dev triggers      # o que está cadastrado e quando cada um vence
```

Ou seja: com o aplicativo aberto numa máquina que não dormiu, um gatilho vencido
continua vencido. Para ver a primeira varredura acontecer na hora, bata à mão. O
temporizador dentro do aplicativo é trabalho que ainda não foi feito, e está no
backlog.

Quando a batida acontece, a varredura faz o seguinte:

1. Pergunta ao GitHub os pull requests abertos do dono, atualizados a partir do
   cursor. Sem cursor gravado, ou seja, na primeira vez, a janela é o último
   dia, e no máximo 50 resultados.
2. Descarta os que não batem com o padrão do repositório.
3. Para cada um que sobrou, busca o diff e grava um evento. O identificador do
   evento inclui o SHA da cabeça, então o mesmo PR com um push novo vira um
   evento novo, e o mesmo PR sem mudança nenhuma não vira.
4. O cursor só avança depois de gravar. Uma queda no meio repete trabalho, mas
   não perde evento.

Cada evento vira uma execução com quatro passos: triagem, auditoria, contexto de
deploy e o comentário. O contexto de deploy é opcional e pede o servidor MCP
`argocd`; sem ele cadastrado, o passo é pulado e a execução segue. O quarto
passo é o que para na fila.

Duas coisas que parecem falha e não são. **Auditoria sem achado nenhum** é o
resultado esperado num PR sem defeito: a lista volta vazia, nada entra na fila e
a execução termina bem. E **execução parada esperando decisão** é o estado
normal do quarto passo, não um travamento.

Se nada aparecer, a lista de execuções diz onde parou:

```bash
npm run dev runs          # as últimas execuções e o estado de cada uma
npm run dev runs failed   # só as que falharam
npm run dev inbox         # as aprovações esperando decisão
```

O gasto aparece na seção de orçamentos da configuração. O agent semente nasce
com teto de 0,40 dólar por execução e 6 por dia, e a execução para ao estourar,
em vez de continuar e cobrar.

## 6. Ler o primeiro review na fila

A contagem na bandeja é o primeiro sinal. Clicando nela, ou abrindo a janela, a
**Inbox** lista o que espera você, com a severidade pior do item numa régua
colorida à esquerda e o repositório, o autor e o tamanho do diff na linha.

Cada item tem três saídas:

**Aprovar** publica o comentário no pull request, do jeito que ele está.

**Editar** abre a revisão do que vai sair. É aqui que a leitura de verdade
acontece: cada achado aparece com arquivo, linha, severidade, o problema e a
correção sugerida, e cada um tem uma marca dizendo se ele entra na publicação. A
tela diz, o tempo todo, quantos achados vão sair. Desmarcar tudo e aprovar
publica nada, que é uma resposta legítima.

**Descartar** fecha o item sem publicar. A execução continua no histórico, com
os achados, para consulta depois.

O que sai leva uma marca invisível no corpo, um comentário HTML que não aparece
para quem lê. Ela existe porque o token é seu: sem a marca, o Locum leria o
próprio comentário como se fosse a confirmação de uma pessoa, quando mais tarde
for cruzar o que ele achou com o que os humanos disseram no PR.

Depois que o pull request fecha, a conferência roda numa batida seguinte do
agendador e cruza o que o Locum apontou com o que as pessoas comentaram e com o
que mudou de fato no código. É o que alimenta a precisão por versão de agent, em
`npm run dev metrics`. Não é preciso fazer nada para isso acontecer: essa parte
só lê.

## O que não sai sem o seu clique

Vale fechar repetindo, porque é a promessa que o resto depende.

O quarto passo do agent semente está cadastrado com `mode: "approve"`. Nesse
modo, a porta de saída grava a pendência, devolve "pendente" e volta, sem chamar
quem publica. O único caminho que publica de verdade é a decisão da fila, e ela
começa numa pessoa clicando.

Existe um modo `draft`, que monta a review no GitHub em estado pendente, visível
só para você, e existe um `auto`, que nasce desligado. Nenhum dos dois está
ligado no agent semente, e trocar isso é edição de agent, não um acaso de
configuração.

A porta de saída é uma só: nada que escreve fora do Locum passa por outro lugar.
E a pendência guarda um identificador externo antes de qualquer tentativa de
publicar, então uma queda no meio e a retomada depois não publicam duas vezes.

O que fica de fora de propósito, e não por falta de tempo: o servidor MCP do
Locum não expõe aprovar nem rejeitar. Um assistente externo consegue ler
achado, cadastrar servidor e disparar execução, e não consegue fazer nada sair.
O porquê está no [ADR 0002](adr/0002-camada-de-servico-e-servidor-mcp.md).
