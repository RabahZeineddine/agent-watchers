# A primeira execução real

Até aqui o Locum foi verificado com evento sintético: o `demo` monta um pull
request de mentira e o pipeline roda sem encostar em nada de fora. Este
documento é o outro lado, o de ligar o aplicativo num repositório de verdade
pela primeira vez.

Os passos estão na ordem em que alguém os faria. Vale a pena ler até o fim antes
de criar o token, porque a seção sobre a primeira varredura explica por que ela
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

**O agent semente gravado no banco.** A tela de repositórios observados precisa
de pelo menos um agent na lista para deixar salvar. O aplicativo cuida disso
sozinho: quando abre num banco sem agent nenhum, grava o `pr-review` e escreve
no log `semente: banco sem agent, pr-review gravado`. Com qualquer agent já no
banco, não grava nada.

A linha de comando continua servindo para trazer a semente para a versão do
código, depois de atualizar o repositório. Com o spec igual ao gravado, ela não
cria versão nova:

```bash
cd app
npm run dev seed
```

O banco fica em `~/Library/Application Support/locum/watchers.db`, fora do
repositório, e é o mesmo para o aplicativo empacotado e para a linha de comando.

**Um runtime que saiba executar os passos.** O agent semente pede
`claude-code/claude-sonnet-5` na triagem e `claude-code/claude-opus-5` na
auditoria, que gastam a sua assinatura pelo binário do Claude Code já
autenticado na máquina. Se esse binário existir e estiver autenticado, não há
nada a fazer aqui, e o passo 1 é só conferência. Se não existir, é o passo 1 que
resolve.

## 1. Ter um modelo que rode nesta máquina

A tela de configuração abre na seção **Provedores**, que lista o que roda neste
computador. Cada linha diz o nome do provedor, se ele está disponível ou
indisponível, e quais variáveis ele usa. O `claude-code` aparece marcado como
assinatura: ele não pede chave, pede o binário. Pela linha de comando a mesma
lista sai de `npm run dev providers`.

Se o provedor que o agent semente pede estiver indisponível, há duas coisas a
fazer, nesta ordem: dar uma chave a algum provedor, e mandar os modelos do spec
caírem nele.

### Guardar a chave de um provedor

Na linha do provedor que você tem chave, o campo **chave de API do
`<provedor>`** aceita colar e **guardar**. É a mesma viagem de mão única da
credencial do GitHub: o valor vai para o keychain do macOS, sob a referência
`provider/<nome>`, e não volta por canal nenhum. O que a tela mostra é se existe
algo guardado, e não o quê.

Guardar deixa o provedor disponível na hora, sem reabrir a janela: quem grava
remonta o registro com a chave nova antes de responder.

**Conferir catálogo** pergunta ao provedor a lista de modelos dele e escreve
quantos vieram, com a data. Serve para separar "a chave está errada" de "o
modelo que eu escrevi no spec não existe lá", que é uma dúvida cara de tirar
dentro de uma execução. Fica atrás de um clique porque sai para a rede, e abrir
a configuração não é pedir exame. Provedor que não publica catálogo, como o
`google`, responde dizendo isso, e não é falha da chave.

Se o keychain estiver fora de alcance neste processo, o campo diz qual variável
de ambiente usar no lugar, por exemplo `ANTHROPIC_API_KEY`. O cofre vem primeiro
quando os dois existem.

### Cadastrar um provedor que não vem de fábrica

A seção **Provedores compatíveis** é para quem fala o protocolo da OpenAI e não
está na lista de fábrica: um segundo endereço da empresa, um Ollama em outra
máquina, um OpenRouter. São três campos, e nenhum deles é a chave:

| campo | o que é |
|---|---|
| identificador | vira o prefixo do modelo, como `meu-gateway` |
| nome | como você chama ele na tela |
| endereço base | `https://gateway.exemplo/v1`, onde mora o `/models` |

Depois de cadastrado, um passo aponta para `meu-gateway/nome-do-modelo`, e a
linha dele aparece na seção de provedores acima, com o mesmo campo de chave dos
de fábrica. A variável de ambiente equivalente é
`LOCUM_PROVIDER_MEU_GATEWAY_KEY`, derivada do identificador.

Duas recusas que são de propósito. Nome de provedor de fábrica não pode ser
tomado: cadastrar `anthropic` apontando para outro endereço mandaria a chave da
Anthropic para lá. E **remover** um provedor que está em uso avisa onde ele
aparece, passo por passo e substituição por substituição, e só remove no segundo
clique, em **remover mesmo assim**. O aviso existe porque a remoção não quebra
nada na hora: ela quebra o próximo run, que é quando ninguém está olhando.

### Mandar o modelo do spec cair no provedor

Com a chave guardada, a seção **Substituição de modelo** aponta
`claude-code/claude-sonnet-5` e `claude-code/claude-opus-5` para os modelos do
provedor que você tem. A substituição é por máquina, e é ela que deixa o mesmo
agent rodar aqui e noutro computador sem editar o spec.

## 2. Criar o token com as permissões mínimas

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
| Checks | leitura, para a auditoria saber o que o CI já apontou |
| Pull requests | escrita, só se quiser que o Locum comente |

Sem a leitura de Checks a revisão continua, e a auditoria recebe só o aviso de
que os checks não puderam ser lidos.

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

## 3. Guardar o token pela interface

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

## 4. Escolher o repositório

Ainda na configuração, a seção **Repositórios observados**. São cinco campos:

**O agent que vai revisar.** Depois do `seed`, `pr-review` é o único, e já vem
escolhido.

**O dono**, que é o login da organização ou da conta. É o `org:` da busca.

**O padrão do nome do repositório**, que é uma expressão regular aplicada ao
nome completo. `^meu-servico$` pega um repositório só. `api-` pega todos que
tenham isso no nome. Comece por um repositório só: a primeira varredura é a hora
de descobrir que o padrão pega mais coisa do que você pensava, e descobrir isso
com um repositório custa menos.

**De quem são os pull requests**, entre qualquer pessoa, os seus e os do time.
O padrão é qualquer pessoa. A comparação é com o login que a conferência do
token guardou no passo 3, e não com uma pergunta nova ao GitHub, então um
gatilho de "meus" ou "do time" falha enquanto o token não tiver sido conferido.

**A cadência em minutos**, que é de quanto em quanto tempo aquele gatilho se
considera vencido.

Clique em **observar**. A linha aparece na lista marcada como **parado**, e é
isso mesmo: cadastrar não liga nada.

## 5. Habilitar o gatilho

Na linha que acabou de aparecer, clique em **ligar**.

Esse é o segundo clique, e ele existe porque cadastrar e começar a gastar são
decisões diferentes. Um gatilho recém-ligado que nunca disparou já está vencido:
ele não espera uma cadência inteira para a primeira batida, porque esperar sem
que ninguém tenha pedido seria só demora.

A linha passa a mostrar a última varredura e a próxima. Enquanto não houver
varredura nenhuma, a última aparece como "nunca".

## 6. O que esperar na primeira varredura

O agendador anda por cursor de tempo, um por gatilho, e é batido de fora. Três
coisas batem:

- **o relógio do aplicativo**, meio minuto depois de abrir e a cada cinco
  minutos dali em diante, enquanto o aplicativo estiver aberto;
- **o evento de energia do macOS**, quando a máquina acorda, que já encontra
  vencido tudo o que passou da hora durante o sono;
- **a batida manual**, pela linha de comando.

```bash
cd app
npm run dev tick          # uma batida nos gatilhos vencidos
npm run dev tick --wait   # o mesmo, esperando as execuções terminarem
npm run dev triggers      # o que está cadastrado e quando cada um vence
```

O relógio não decide o que dispara, só pergunta. Um gatilho de quinze minutos
dispara quando a batida seguinte encontrar a cadência vencida, então o atraso
fica em até cinco minutos. Os cinco minutos são de propósito: cada batida também
roda a conferência de pull request fechado, que pergunta ao GitHub, e bater a
cada minuto gastaria cota da API para descobrir que nada mudou. Duas batidas
nunca rodam juntas; quem chega com uma em andamento espera por ela.

Com o gatilho recém-ligado, a primeira varredura acontece na próxima batida do
relógio, em até cinco minutos. Para não esperar, bata à mão. Pausar na bandeja
para o relógio e o acordar, e não para a batida manual.

Batida do relógio em que nada venceu não escreve nada no log. Gatilho que falha
escreve sempre, com o motivo, por exemplo `relógio: batida: gatilho <id> falhou:
sem token do GitHub`.

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
resultado esperado num PR sem defeito: a lista volta vazia, o veredito sai
`APPROVE` e o item entra na fila do mesmo jeito, porque aprovar um pull request
em seu nome também é algo que sai assinado por você. E **execução parada
esperando decisão** é o estado normal do quarto passo, não um travamento.

Se nada aparecer, a lista de execuções diz onde parou:

```bash
npm run dev runs          # as últimas execuções e o estado de cada uma
npm run dev runs failed   # só as que falharam
npm run dev inbox         # as aprovações esperando decisão
```

O gasto aparece na seção de orçamentos da configuração. O agent semente nasce
com teto de 0,40 dólar por execução e 6 por dia, e a execução para ao estourar,
em vez de continuar e cobrar.

O teto em dólar só enxerga provedor por chave se o modelo tiver preço. O Locum
não traz tabela de preço, porque ela muda sem aviso e gateway cobra o que
quiser: cadastre entrada e saída, em dólar por milhão de tokens, na linha do
provedor. Sem preço, o passo custa zero no registro, e a seção de orçamentos
avisa que o teto está medindo em tokens; `set_budget` pelo servidor MCP aceita
`perRunTokens` e `perDayTokens` para esse caso.

## 7. Ler o primeiro review na fila

A contagem na bandeja é o primeiro sinal. Clicando nela, ou abrindo a janela, a
**Inbox** lista o que espera você, com a severidade pior do item numa régua
colorida à esquerda e o repositório, o autor e o tamanho do diff na linha.

Cada item tem três saídas:

**Aprovar** publica a review no pull request, do jeito que ela está, com o
veredito que a auditoria escolheu.

**Editar** abre a revisão do que vai sair. É aqui que a leitura de verdade
acontece: cada achado aparece com arquivo, linha, severidade, o problema e a
correção sugerida, e cada um tem uma marca dizendo se ele entra na publicação. A
tela diz, o tempo todo, quantos achados vão sair.

O **veredito** também se troca aqui, entre aprovar, só comentar e pedir
mudança. A auditoria decide pela régua do prompt: pedir mudança quando há achado
crítico, ou alto com confiança alta; aprovar quando não há achado, ou só baixo;
só comentar no meio. Desmarcar todos os achados deixa sair só o veredito, e a
tela avisa isso. Se a intenção é não dizer nada, o caminho é descartar.

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

## 8. Quando o achado precisa virar tarefa

Este passo é opcional, e fica por último de propósito: ele só faz sentido depois
que você leu alguns reviews e concluiu que uma parte do que sai merece card no
quadro, e não comentário no pull request. O agent semente não abre tarefa
nenhuma, e nada do que está aqui liga sozinho.

### Onde pegar a credencial

São dois trackers, e cada um pede uma coisa diferente.

**Jira.** O token sai de
[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
e ele não anda sozinho: o Jira Cloud autentica por básica, com o e-mail da conta
junto do token. Por isso o cadastro pede o e-mail, e recusa sem ele. O endereço
base é o da sua instância, `https://empresa.atlassian.net`.

**GitHub Issues.** Um token com escrita em Issues no repositório de destino
basta. Ele é separado do token da varredura de propósito: são permissões
diferentes, e um token que só lê pull request não abre issue. Separar os dois é
o que permite conceder escrita de issue sem conceder escrita em pull request. O
endereço base é `https://api.github.com`, que é o que fica se o campo for
deixado vazio.

### Cadastrar

Na configuração, a seção **Trackers de tarefa**. O tipo escolhe entre os dois, o
identificador é como o passo de ação vai apontar para este cadastro, e o destino
padrão é onde a tarefa cai: a chave do projeto no Jira, `ABC`, ou `dono/repo` no
GitHub.

Feito o cadastro, a linha ganha o campo de credencial. Colar e **guardar** manda
o valor para o keychain, sob `tracker/<identificador>`, e a tela passa a dizer
só que existe algo guardado. **Testar** pergunta ao tracker quais destinos esta
credencial alcança e escreve quantos são. É o teste de conexão e o de permissão
ao mesmo tempo: credencial que enxerga zero destino não vai conseguir criar nada.

Cadastrar não abre tarefa nenhuma, e nem liga passo nenhum. O cadastro é só o
endereço e a credencial.

### O que o Locum cria

O par de passos que abre tarefa mora em `app/src/seed/tracker-issue.ts`, como
fragmento, e não dentro do agent semente: abrir tarefa é escolha de quem escreve
o agent, e o `pr-review` de fábrica não tem tracker para apontar. Quem quiser
concatena os dois passos ao spec do agent dele. O editor da tela troca modelo,
prompt, ferramentas, modo e orçamento dos passos que já existem, e ainda não
acrescenta passo; a concatenação é pelo `upsert_agent` do servidor MCP, e o
passo de tarefa gravado por ali nasce em `approve` de qualquer forma.

São dois, e não um handler esperto. O primeiro é de modelo e escreve só prosa,
em três campos: o objetivo, o que mudou e o que testar. O segundo é de ação,
monta o item e para na fila. A divisão é o ponto: o texto que sai em nome de uma
pessoa precisa ser legível por ela antes de sair, e prosa montada dentro da
publicação só apareceria depois de publicada.

O que o modelo não escolhe: o título, que sai como `repo#numero: título do pull
request`, para que dois cards nascidos de pull requests parecidos não fiquem
indistinguíveis na lista de quem vai pegar um deles; e o destino, que vem do
cadastro. Um modelo que escolhesse o projeto abriria tarefa no quadro errado.

O corpo sai com **Objetivo**, **O que mudou**, **O que testar** e **Links**, com
o endereço do pull request no fim. Esse endereço no corpo não é enfeite: é por
ele que a publicação procura se já existe tarefa para aquele pull request, e
desiste em silêncio se achar. Sem isso, uma segunda execução aprovada dias
depois abriria um segundo card para a mesma coisa.

No Jira a tarefa nasce como `Task`. As etiquetas que o modelo sugerir vão junto,
e o tracker que não conhecer uma delas é quem recusa.

### Por que criar tarefa nunca é automático

O passo de ação `tracker.create_issue` aceita um modo só, `approve`, e isso está
travado no handler, não no spec. É diferente do passo que comenta no GitHub, que
tem `draft` e `auto` desligados: aqui os outros modos não existem.

A razão é que card em sistema de tarefa aparece assinado por você para o time
inteiro, e um agent que decidisse sozinho abriria tarefa em nome de quem nunca
leu o texto. Uma trava por configuração dependeria de a linha certa estar
escrita na spec, e spec se edita à mão.

Não há `draft` por uma segunda razão: rascunho de tarefa não existe nos dois
trackers, e emular um criando e fechando deixaria o card no histórico do quadro,
que é exatamente o que não se queria.

E não há canal na ponte que crie tarefa. A janela cadastra, testa e aponta o
destino padrão; criar é só pelo passo de ação, que para na fila. Um canal de
janela seria um segundo caminho até o tracker, sem a fila no meio.

## O que não sai sem o seu clique

Vale fechar repetindo, porque é a promessa que o resto depende.

O quarto passo do agent semente está cadastrado com `mode: "approve"`. Nesse
modo, a porta de saída grava a pendência, devolve "pendente" e volta, sem chamar
quem publica. O único caminho que publica de verdade é a decisão da fila, e ela
começa numa pessoa clicando.

Existe um modo `draft`, que monta a review no GitHub em estado pendente, visível
só para você, e existe um `auto`, que nasce desligado. Nenhum dos dois está
ligado no agent semente, e trocar isso é edição de agent, não um acaso de
configuração: na tela **Agents**, **Editar** mostra o modo de cada passo de
ação, e salvar pede uma nota dizendo o que mudou, que vira o registro da versão.

Mesmo em `auto`, a review que aprova ou pede mudança espera o clique. Só a que
apenas comenta sai sozinha. A trava está no handler, pelo veredito, e não no
spec. Um spec gravado pelo servidor MCP com `draft` ou `auto` é rebaixado para
`approve` na gravação, porque subir modo é clique de pessoa; o assistente da
janela nem chega a gravar agent.

A porta de saída é uma só: nada que escreve fora do Locum passa por outro lugar.
E a pendência guarda um identificador externo antes de qualquer tentativa de
publicar, então uma queda no meio e a retomada depois não publicam duas vezes.

O que fica de fora de propósito, e não por falta de tempo: o servidor MCP do
Locum não expõe aprovar nem rejeitar. Um assistente externo consegue ler
achado, cadastrar servidor e disparar execução, e não consegue fazer nada sair.
O porquê está no [ADR 0002](adr/0002-camada-de-servico-e-servidor-mcp.md).
