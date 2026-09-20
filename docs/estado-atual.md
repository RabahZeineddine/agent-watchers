# Estado atual

Projeto renomeado de Agent Watchers para Locum em 19 de setembro de 2026.

Atualizado em 19 de setembro de 2026.

## O que existe e roda

Núcleo headless em `app/`, verificação de tipos limpa. A casca Electron já sobe
e carrega a página construída em `app/renderer`, ainda sem tela de verdade.
Tudo que existe continua alcançável pela linha de comando, com o mesmo executor
que a interface vai usar.

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
| casca Electron | processo principal com `--smoke`, bandeja com contagem de pendências, início no login por preferência guardada, eventos de energia batendo o agendador e deep link de OAuth |
| credenciais no keychain | `safeStorage` cifra, o banco guarda só a referência, e sem keychain vale a variável de ambiente |
| notificação nativa | um aviso por run, para achado crítico na fila ou run que falhou, com o clique apontando para o run |
| deep link `locum://` | esquema registrado no sistema, retorno de OAuth com PKCE roteado do `open-url` até o cofre |
| ponte entre janela e serviços | preload em sandbox, 22 canais tipados pelos próprios métodos dos serviços, decisão de aprovação só encaminhada |
| interface | esqueleto do renderer em Vite com React e Tailwind, construído para `dist/renderer` e carregado pela janela, já lendo pela ponte |
| componentes da interface | shadcn e AI Elements vendorizados em `app/renderer/components`, tema escuro por padrão, sem dependência de rede |
| cliente da ponte no renderer | `app/renderer/lib/bridge.ts` com catálogo de leitura escrito à mão e hook `useRead`, a janela lendo agents, execuções e fila |

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
npm run build:renderer                # constrói a página em dist/renderer
npm run build                         # processo principal mais página
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

**Preload só roda quando um documento carrega.** Conferir que o
`dist/preload.cjs` existe não prova ponte nenhuma: enquanto a janela não chama
`loadURL`, o preload nem é executado e `window.locum` não existe. Por isso o
smoke sobe uma janela com `show: false`, carrega `about:blank`, e pergunta ao
próprio renderer o que ele enxerga. Nada aparece na tela e o caminho inteiro é
exercitado, do `contextBridge` até o serviço.

**`packages: "external"` não vale para o preload.** No sandbox não existe
resolução por `node_modules`: o que não estiver dentro do arquivo não carrega. O
pacote do preload sai com tudo embutido e só `electron` como externo, que é o
único módulo que o sandbox fornece. Por isso o contrato da ponte, que os dois
lados importam, não tem import de valor vindo de `src/`: um só arrastaria o
núcleo e o `better-sqlite3` para dentro do preload.

**Erro de handler de IPC sempre vai para o log.** O Electron registra toda
rejeição de `ipcMain.handle`, e o smoke prova de propósito que decidir sobre uma
pendência inexistente é recusado. A linha de erro que aparece depois do aviso
`ponte: a proxima linha de erro e a recusa esperada da gate` é o teste passando.

**Módulo ES em `file://`.** A página construída pelo Vite sai com
`<script type="module">`, e num Chrome de mesa isso não carrega de `file://`,
porque a origem é opaca e o import bate em CORS. O Electron não aplica essa
recusa, então a janela carrega o `dist/renderer/index.html` do disco direto,
sem servidor e sem esquema próprio registrado. O que a página precisa em troca
é `base` relativa no Vite: caminho absoluto viraria a raiz do volume.

**Raiz montada não prova folha de estilo.** O smoke pergunta ao renderer se o
`#root` tem filho, o que só diz que o React rodou. A página carrega um marcador
com a classe `hidden`, e o smoke confere que ele está com `display: none`: se o
CSS construído não tivesse chegado, a raiz montaria igual e o teste passaria
sem interface nenhuma. O console de erro do renderer entra no mesmo exame,
porque módulo que falha ao carregar deixa a raiz vazia sem estourar do lado do
processo principal.

**`vite build` recebe a raiz por posição.** No Vite 8 não existe `--root` na
linha de comando: a opção é o argumento posicional, e passar a flag aborta com
`Unknown option`. O `build:renderer` chama
`vite build --config renderer/vite.config.ts renderer`.

**O `shadcn add` não roda sozinho.** Ele pergunta a biblioteca de componente
(Base UI, React Aria, Radix UI) mesmo com `--yes`, e a resposta não cabe no
`components.json`: o campo não existe no esquema. Para trazer o vendor deste
marco a escolha foi empurrada pela entrada padrão, com
`printf '\033[B\033[B\n' |` antes do comando, que é o Radix, que é o que o AI
Elements espera. E ele só roda onde existe `package.json`, por isso o
`components.json` mora em `app/` e não em `app/renderer/`, com o apelido `@/`
declarado nos dois `tsconfig.json`. O que vem do registry do AI Elements cai em
`app/src/components/ai-elements`, porque a CLI vê a pasta `src` e se guia por
ela; o lugar certo é `app/renderer/components/ai-elements`, e mover é parte do
trabalho.

**O `cn` mudou de casa.** Os componentes novos do shadcn importam de um pacote
`cn`, que é o `clsx` mais o `tailwind-merge` compilados, e não mais de
`@/lib/utils`. Os do AI Elements continuam pedindo `@/lib/utils`. Por isso
`app/renderer/lib/utils.ts` é uma reexportação de uma linha: duas
implementações de merge brigariam no mesmo elemento.

**Token do shadcn não vem do `add`.** Só o `init` escreve a folha, e o estilo v4
manda importar `shadcn/tailwind.css`, que é a própria CLI virando dependência de
build por causa de um arquivo. Em vez disso os tokens da paleta zinc foram
copiados do registry para dentro de `renderer/src/index.css`, pelo mesmo motivo
dos componentes: nada da interface pode depender de rede. O que veio de pacote
foi só o `tw-animate-css`, porque os componentes usam `animate-in` e
`slide-in-from-top-2`.

**O shiki traz todas as gramáticas.** O `codeToHtml` do pacote raiz alcança o
conjunto inteiro de linguagens, e o Vite parte isso em mais de 600 pedaços
separados, carregados sob demanda. Funciona de `file://`, e o smoke prova isso
esperando o destaque aparecer: import dinâmico do disco é justamente o que o
teste exercita. O preço é o tamanho de `dist/renderer`, que só importa quando o
empacotamento entrar.

**Destaque de código não está no HTML construído.** O shiki colore no navegador,
depois que a página montou, e ainda espera a gramática chegar. Conferir logo
depois do `loadFile` encontraria o `pre` vazio. Por isso o smoke gira até
aparecer `span` com cor dentro do bloco, e sem gramática o `pre` até existiria,
só que com o código todo da mesma cor.

**Catálogo de leitura da janela, e o que o compilador vigia.** O
`READ_CHANNELS` de `app/renderer/lib/bridge.ts` é lista escrita à mão, e a
emenda 5 do ADR 0003 é o motivo: derivar de `BRIDGE_CHANNELS` seria mais curto
e entregaria `approvals.decide` junto, mais todo canal de escrita que aparecer
depois. Revisão humana esquece disso, então existe uma guarda de tipo no mesmo
arquivo: se o canal de decisão entrar na lista, o `Extract` deixa de ser `never`
e o `npm run build` para antes de a janela enxergar o canal.

**O contrato da ponte typecheca no renderer.** O `renderer/tsconfig.json` não
tem `node` em `types`, e mesmo assim o `import type` de
`electron/bridge-contract.ts` passa: o contrato só tem tipo, e o que ele puxa de
`src/services/` chega por `import type` também. Import de valor vindo de lá
quebraria isso na hora.

**Argumento de hook entra por valor, não por referência.** O `useRead` põe
`JSON.stringify(args)` na lista de dependência do efeito. Quem chama passa
objeto literal, que muda de referência a cada render, e comparar por identidade
dispararia a leitura em laço. Os argumentos de verdade viajam numa `ref`, porque
espalhá-los na lista traria a identidade de volta.

**Banco vazio faz o smoke passar sem provar nada.** A comparação entre o que a
janela leu e o que o serviço devolve é verdadeira por acidente quando os dois
lados são zero: uma ponte que respondesse `[]` sempre passaria igual. Por isso o
banco do worktree precisa do `seed`, e por isso o marcador carrega os
identificadores dos agents, e não só a contagem.

**A página lê ao montar, então o smoke precisa da ponte no ar.** O
`checkRenderer` passou a chamar `setupBridge` e `trustWindow` antes do
`loadFile`, e a esperar o marcador `ponte` sair de "carregando": conferir logo
depois do `loadFile` pegaria a tela no estado de leitura pendente. O estado vai
no próprio marcador justamente para a espera saber a hora, em vez de dormir um
tempo arbitrário.

**Nome do helper do AI SDK.** É `stepCountIs`, não `isStepCount`.

**Dois ABI do `better-sqlite3`.** O módulo compilado para o Node do sistema não
carrega no Electron, e o `electron-rebuild` sobrescreve o mesmo caminho, o que
quebraria a linha de comando. O build guarda a cópia de Electron em `app/native/`
e devolve o `node_modules` ao estado de Node; o processo principal aponta
`LOCUM_SQLITE_BINDING` antes de importar o núcleo.

**Depois de um merge que traz dependência nova**, rode `npm install` e
`npx drizzle-kit push --force` na árvore principal: o worktree do loop tem
`node_modules` e banco próprios, então nada disso vem junto.

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
