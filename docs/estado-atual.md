# Estado atual

Projeto renomeado de Agent Watchers para Locum em 19 de setembro de 2026.

Atualizado em 19 de setembro de 2026.

## O que existe e roda

Núcleo headless em `app/`, 20 arquivos TypeScript, verificação de tipos limpa.
A casca Electron ainda não existe; tudo passa pela linha de comando, com o mesmo
executor que a interface vai usar.

| área | estado |
|---|---|
| esquema SQLite com 17 tabelas | pronto |
| AgentSpec em zod, herança de ferramentas, ordenação topológica | pronto |
| registro de provedores e resolução de fallback por máquina | pronto, com cadastro pelo serviço |
| registro MCP com spawn sob demanda e encerramento por ocioso | pronto, lendo o cadastro do banco |
| runtime nativo sobre o AI SDK | pronto, sem teste com chave real |
| runtime de assinatura sobre `claude -p` | pronto e verificado |
| executor durável com retomada | pronto e verificado |
| orçamento por execução e por dia | pronto e verificado |
| fila de aprovação com identificador externo antes da publicação | pronto |
| fonte GitHub com varredura por cursor | escrito, sem teste com token |
| ação de review com modo rascunho e modo aprovação | escrita, sem teste com token |
| descoberta de skills e seleção por arquivo alterado | pronto |
| servidor MCP próprio | 19 ferramentas de leitura, configuração e execução sobre a camada de serviço, registrado em `.mcp.json` |
| cadastro de gatilho | serviço pronto, nasce desabilitado, sem quem dispare |
| reconciliador de review humano | pronto, verificado com evento e reviews sintéticos, sem teste com token |
| métricas por versão de agent | agregação de `finding_outcomes` em `agent_metrics`, por versão mais conjunto de skills |
| agendador | cursor de tempo por gatilho, batido de fora, sem relógio próprio; acordado pelo evento de energia do Electron |
| camada de serviço, dez serviços | pronto |
| servidor MCP próprio, 19 ferramentas | pronto |
| reconciliador de review humano | pronto, sem teste com token |
| métricas por versão | pronto |
| agendador por cursor | pronto, batido pelo `resume` do `powerMonitor` |
| casca Electron | processo principal com `--smoke`, bandeja com contagem de pendências, início no login por preferência guardada, eventos de energia batendo o agendador e deep link de OAuth, sem interface ainda |
| credenciais no keychain | `safeStorage` cifra, o banco guarda só a referência, e sem keychain vale a variável de ambiente |
| notificação nativa | um aviso por run, para achado crítico na fila ou run que falhou, com o clique apontando para o run |
| deep link `locum://` | esquema registrado no sistema, retorno de OAuth com PKCE roteado do `open-url` até o cofre |
| interface | não começou |

## Execução verificada

Evento sintético com quatro defeitos plantados em C#, rodando na assinatura:

```
 1  Triagem              done      claude-code/claude-sonnet-5   62s
 2  Auditoria            done      claude-code/claude-opus-5     74s
 3  Contexto de deploy   skipped   servidores indisponiveis: argocd
 4  Comentar no PR       awaiting_approval

custo: 0.000 USD cobrado, 0.930 USD equivalente
```

Os quatro defeitos foram encontrados. Passo opcional sem servidor foi pulado com
motivo registrado, o passo de ação parou o run e criou a pendência, e a retomada
não reexecutou os passos concluídos.

## Comandos

```bash
cd app
npm install
npm run db:push
npm run dev seed
npm run dev demo                      # não precisa de credencial
npm run dev review owner/repo#123     # precisa de GITHUB_TOKEN
npm run dev poll 'time/.*'
npm run dev inbox
npm run dev runs
npm run dev reconcile <run-id>        # precisa de GITHUB_TOKEN, só leitura
npm run dev metrics                   # recalcula e imprime precisão por versão
npm run dev rerun <run-id> audit
npm run dev triggers                  # gatilhos cadastrados e quando o agendador quer a próxima batida
npm run dev tick                      # uma batida nos gatilhos habilitados
npm run dev providers
npm run dev mcp
npm run dev mcp:register locum-fixture stdio 'npx tsx src/fixtures/mcp-fixture-server.ts'
npm run dev secrets                   # credenciais guardadas e quem aponta para elas
npm run dev secret:link mcp:locum-fixture mcp/locum-fixture
npm run dev secret:unlink provider:anthropic
npm run dev startup                   # o Locum sobe junto com o login?
npm run dev startup:on                # passa a subir, valendo na próxima subida
npm run dev startup:off               # deixa de subir
npm run mcp                           # servidor MCP próprio, por stdio
npm run dev approve <id>
npm run dev resume
npm run build:main                    # empacota o processo principal em dist/main.cjs
npm run smoke                         # sobe o Electron sem janela e sai 0
npx electron dist/main.cjs --set-secret provider/anthropic     # valor pelo stdin
npx electron dist/main.cjs --remove-secret provider/anthropic
npm start                             # sobe o Electron com janela
```

## Armadilhas encontradas

**Instalação.** O pnpm 12 e o npm 11 bloqueiam scripts de build por padrão. Para
`better-sqlite3` e `esbuild` é preciso aprovar com `npm approve-scripts` antes de
`npm rebuild`.

**`drizzle-kit push` com dados.** Alteração que exige recriar tabela falha com
`SQLITE_CONSTRAINT_FOREIGNKEY` quando já existem linhas. Coluna nova se resolve
com `alter table add column` manual.

**Autoria da review automática.** O token é pessoal, então o que o Locum
publica sai assinado pela mesma conta que revisa a mão. Sem marca no corpo, o
reconciliador leria o próprio achado como confirmação humana dele mesmo. Por
isso tudo que sai leva um `<!-- locum -->`, invisível no GitHub, e o
reconciliador descarta a review e os comentários que a carregam.

**Dois ABIs para o mesmo `better-sqlite3`.** O binário em `node_modules` é
compilado para o ABI do Node, que a linha de comando usa por `tsx`. O Electron
tem ABI próprio e recusa esse binário, e os dois não cabem no mesmo caminho.
O `build:main` recompila para o Electron, guarda a cópia em `app/native/`, e
devolve o `node_modules` ao estado de Node. Quem carrega escolhe: o processo
principal aponta `LOCUM_SQLITE_BINDING` para a cópia antes de importar o núcleo,
e sem a variável vale o caminho padrão.

**Item de login fora de app empacotado.** O macOS só aceita
`app.setLoginItemSettings` de aplicativo empacotado, assinado e notarizado.
Rodando por `npx electron` a chamada volta com `Operation not permitted` no log
e nada é registrado. Por isso a preferência guardada no banco é a fonte da
verdade, e o processo principal reconcilia o sistema com ela a cada subida, em
vez de ler o sistema e acreditar. A preferência tem três estados: sem linha na
tabela `settings` quer dizer que ninguém decidiu, e aí o app não mexe em nada.

**Onde o segredo cabe.** O Electron não expõe a API de item do keychain, só o
`safeStorage`, que guarda a chave de cifra no keychain e devolve texto cifrado
para quem chamou. Então o par é chave no keychain mais texto cifrado num arquivo
por credencial dentro da pasta do app, e no banco fica apenas o `credential_ref`.
Gravar exige o app aberto; quem usa a linha de comando lê `undefined` e cai para
a variável de ambiente, que é como sempre funcionou.

**Marcador de credencial no cadastro de MCP.** O valor `${credential}` em `env`
ou `headers` é onde o segredo entra na hora de conectar. A substituição acontece
num caminho separado do que alimenta tela, log e ferramenta de leitura, para que
não exista listagem por onde um segredo decifrado escape. Sem nada guardado, a
entrada de `env` cai para a variável de ambiente de mesmo nome, e não havendo
nem isso a entrada some do mapa: mandar o marcador adiante viraria um token
literal numa chamada de rede.

**Notificação é sobre o que chegou agora.** A primeira leitura da fila na
subida só marca o que já estava lá, sem mostrar nada: subir o Locum depois de
uma semana desligado despejaria uma pilha de avisos de coisa velha. O acumulado
tem lugar próprio, que é a contagem na bandeja. Por isso a memória do que já foi
avisado é de sessão e não vai para o banco.

**Dono do esquema `locum://` fora de app empacotado.** Ao contrário do item de
login, o `setAsDefaultProtocolClient` funciona rodando por `npx electron`, e o
`isDefaultProtocolClient` volta verdadeiro. O que fica registrado no sistema,
porém, é o binário do Electron, não o Locum: enquanto não houver empacotamento,
abrir um `locum://` acorda o Electron sem o `dist/main.cjs`. O empacotamento
precisa declarar `CFBundleURLTypes` no `Info.plist`, porque a chamada em tempo
de execução não substitui a declaração do bundle.

**A URL do deep link é entrada de fora.** Qualquer programa da máquina abre um
`locum://`, então nada do que vem nela é confiável: a leitura nunca estoura, o
que não bate vira rota desconhecida e é descartado, e o motivo registrado no log
não repete a consulta, que é por onde o `code` viaja. O `state` é comparado em
tempo constante e consumido antes da troca do código, para que um segundo
retorno com o mesmo `state` não valha nada.

**Onde o token de OAuth cabe.** O que vai para o cofre é o valor pronto do
cabeçalho, `Bearer <token>`, e não o token cru: a substituição de `${credential}`
troca o valor inteiro da entrada de `headers`, então não sobra lugar para montar
o prefixo depois. O par `state` mais `code_verifier` também mora no cofre, e não
em memória, porque o macOS pode ter fechado o Locum enquanto a pessoa autorizava
no navegador e a abertura do `locum://` sobe um processo novo, que não lembra de
nada.

**Nome do helper do AI SDK.** É `stepCountIs`, não `isStepCount`.

**Tipagem das ferramentas.** Tipar o conjunto de ferramentas como
`Record<string, unknown>` faz a inferência do `stopWhen` cair para `never`. Use
`ToolSet` do pacote `ai`.

**Caminho do servidor no `.mcp.json`.** O formato não tem campo para diretório
de trabalho: o cliente sobe o processo na raiz do repositório, onde não existe
`node_modules`. Por isso o registro chama `node` com o caminho do `tsx` dentro
de `app/node_modules`, em vez de `npm run mcp`, que ainda escreveria o cabeçalho
do script no stdout e corromperia a sessão.

## Próximos passos

Quebrados em tarefas atômicas em `scripts/ralph/prd.json`, na ordem revisada pelo
ADR 0002: camada de serviço, servidor MCP próprio, casca Electron, interface,
empacotamento. O cadastro de MCP já vem do banco, e o passo de contexto de
deploy passa a depender só de cadastrar o servidor certo.

O agendador não tem relógio próprio. Ele é batido de fora, hoje pelo comando
`tick`, e devolve em `nextDueAt` quando quer a próxima batida, para quem chama
armar um temporizador só. Cada gatilho tem seu cursor de tempo na tabela
`cursors`, então sono da máquina não perde janela: a primeira batida depois de
acordar já encontra o gatilho vencido. Quem chama `onWake()` é o processo
principal do Electron, em `app/electron/power.ts`, no `resume` do
`powerMonitor`, e o tempo que a máquina passou dormindo vai para o log.

Para exercitar cliente MCP sem depender de nada instalado na máquina, existe
`app/src/fixtures/mcp-fixture-server.ts`, um servidor stdio de brinquedo com as
ferramentas `echo`, `sum`, `slow` e `fail`.
