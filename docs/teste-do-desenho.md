# Teste do desenho

Escrito em 21 de setembro de 2026, ao fechar o marco M8.

## A pergunta

O ADR 0001 fez uma promessa estrutural e nunca foi cobrado por ela. A decisão 8
diz que as fontes de evento têm três implementações atrás da mesma interface,
sendo a terceira a consulta a servidor MCP. A decisão 9 diz que cada ação
declara um modo e que escrita externa passa pela fila. A decisão 6 diz que o
agent define ferramentas e o passo herda.

A leitura combinada das três é uma aposta: fonte nova e ação nova entram como
periferia, sem que o executor, a fila de aprovação e o formato de agent precisem
saber que elas existem.

O M8 é o primeiro marco que exercita a aposta inteira de uma vez. Ele trouxe
duas fontes novas, a varredura genérica por consulta a servidor MCP e as menções
do Slack, e duas ações novas, a entrega de digest e a resposta em thread. Este
documento responde se a promessa se sustentou, com o diff como prova.

## O recorte

Núcleo, aqui, são os quatro lugares que a promessa nomeia:

- o executor, em `app/src/executor/executor.ts`
- a fila de aprovação, em `app/src/approval/gate.ts`
- o formato de agent e de gatilho, em `app/src/config/types.ts`
- o esquema do banco, em `app/src/db/` e `app/drizzle/`

O intervalo é `ab70698..26322ec`, quatro commits:

| commit | story | o que entrou |
|---|---|---|
| `1eb1d80` | M8.1 | fonte que varre por consulta a servidor MCP |
| `284cb41` | M8.2 | fonte de menções do Slack |
| `5e4a47a` | M8.3 | agent de digest e a ação `digest.deliver` |
| `26322ec` | M8.4 | ação `slack.post` |

Somados, 1928 linhas inseridas e 36 removidas em `app/src`, distribuídas em 16
arquivos.

## A resposta curta

A promessa se sustentou para fonte. Não se sustentou inteira para ação, e a
diferença é de duas linhas por ação, num arquivo só.

## O que não foi tocado

Dos quatro lugares do recorte, três ficaram intactos no marco inteiro:

- `approval/gate.ts` não mudou. Sua última alteração é `8db03a7`, do M7.4. As
  duas ações novas entraram pela interface `ActionHandler` que já existia, e a
  recusa de modo das duas usa o campo `modes`, que nasceu naquele commit para o
  `tracker.create_issue`. O `digest.deliver` é o caso mais forte: ele é uma ação
  que não publica em lugar nenhum, o clique quer dizer apenas "li", e ainda
  assim coube na fila sem emenda.
- `executor/executor.ts` não mudou. Última alteração também em `8db03a7`. Ele
  continua sem saber que Slack existe.
- `config/types.ts` não mudou. Última alteração em `db96069`, do M7.5. O tipo de
  gatilho `mcp-poll` já estava lá desde `5d3b90e`, e o campo `action` do
  `ActionStep` é `z.string()` com um comentário que cita `slack.post` como
  exemplo desde `fcc6eb0`, o primeiro commit da arquitetura v2. A ação virou
  real seis marcos depois, sem que o formato mudasse uma linha.

O esquema do banco também não mudou. Continuam sendo as mesmas três migrações em
`app/drizzle`. O cadastro do Slack mora em `settings`, e não em tabela própria,
decisão registrada em `app/src/services/slack-service.ts:77`: é um cadastro por
máquina, e tabela para linha única é cerimônia.

## O que precisou mudar, e por quê

Dois arquivos do núcleo foram tocados.

### `executor/build.ts`, quatro linhas

Duas por ação: o import do handler e a entrada no mapa da gate.

```
+      ["digest.deliver", digestDeliverHandler()],
+      ["slack.post", slackPostHandler()],
```

Essa é a parte da promessa que não se sustenta. Ação nova encosta no núcleo, por
construção. Vale dizer que é deliberado e não acidental: `buildGate()` é onde a
fila é montada, e ela só vale como porta única enquanto for sempre a mesma
porta. Um registro por descoberta automática, varrendo um diretório de handlers,
tiraria as duas linhas do diff e colocaria no lugar delas a possibilidade de um
arquivo solto virar ação publicável sem ninguém ter escrito o nome dela. O custo
é conhecido, é de duas linhas, e cresce linearmente com a quantidade de ações.

### `triggers/scheduler.ts`, 56 linhas inseridas e 36 removidas

Aqui a conta é melhor do que o número sugere. A maior parte é remoção: o
agendador tinha um `callServer()` privado e uma função `digest()` que montava
chave de evento por sha1 do resultado inteiro. As duas saíram, porque cursor,
normalização e deduplicação passaram a morar na fonte, em
`app/src/sources/mcp-poll.ts`, que é onde já moravam para o GitHub. O marco
deixou o agendador menor em responsabilidade do que encontrou.

O que entrou no lugar é uma chamada à fonte e um tratamento de detalhe da
batida. Isso é a promessa funcionando.

Sobra um ponto, e ele é o mais honesto de registrar.

## Onde a promessa vazou

Dentro do ramo `mcp-poll` do agendador, em `scheduler.ts:381`, existe isto:

```ts
const watch = await slackWatchFor(config.server, { slack: this.slack });
if (watch !== null) { ... }
```

O agendador pergunta se o servidor apontado pelo gatilho é o que alguém
cadastrou como o Slack daquela máquina e, se for, desvia para a varredura por
canal. É conhecimento de uma fonte específica dentro de um arquivo compartilhado.

Existe uma razão para estar ali: a lista de canais observados é do cadastro do
Slack, não do gatilho, porque ela muda sem que o gatilho mude. Mas a razão
explica a escolha, não a apaga. Se amanhã entrar uma fonte de Teams com a mesma
forma, o desvio vira o segundo `if`, e aí a promessa terá vazado de verdade. O
sinal de alerta é esse segundo `if`, e quem o escrever deveria promover o desvio
a uma tabela de fontes registradas antes de escrevê-lo.

## A casca, que não é o núcleo mas conta

Fora de `app/src`, o marco somou 1466 linhas, quase todas em
`app/electron/main.ts`. Vale desagregar, porque o número assusta sem motivo: das
1064 linhas que entraram nesse arquivo, cerca de 1030 são as cinco funções de
verificação, de `semSlack` a `checkSlackWindow`, que ocupam as linhas 2665 a
3697. O que o marco acrescentou de fiação de verdade no processo principal cabe
em algumas dezenas de linhas.

O `bridge-contract.ts` cresceu 37 linhas para quatro canais de cadastro, todos
de leitura e escrita de configuração. Nenhum deles publica. Isso é garantido por
código, e não por disciplina: o arquivo carrega uma guarda de tipo que falha o
`npm run build` se algum canal chamado `slack.post`, `slack.send` ou
`slack.reply` aparecer na lista. Enquanto o `Extract` for `never`, a janela não
tem como publicar no Slack sem passar pela fila.

## Veredito

Das quatro peças do núcleo, três ficaram com zero linha alterada em um marco que
escreveu quase duas mil. A quarta mudou quatro linhas, e são as quatro linhas
que registram ação nova na fila, que é exatamente o lugar onde o desenho quis
que houvesse atrito.

Fonte nova não encostou no núcleo, e essa parte da promessa está cumprida sem
ressalva. Ação nova encosta, sempre, em duas linhas. O ADR 0001 dava a entender
que não encostaria; a prática diz que encosta, e que é barato e desejável que
encoste.

A ressalva real não é nenhuma das duas. É o desvio do Slack dentro do agendador,
que hoje é um caso único e legível, e que na segunda ocorrência deixa de ser.
