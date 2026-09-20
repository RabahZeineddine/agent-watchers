# ADR 0003: Interface sobre AI Elements e o chat como console

Data: 2026-09-19
Status: aceito
Complementa: ADR 0002

## Contexto

A interface do marco M4 precisa mostrar execução de agent, raciocínio, chamada
de ferramenta, trecho de código com destaque, e resultado de auditoria. Escrever
esses componentes à mão é a parte mais cara do marco.

O AI SDK, que já é a base do runtime nativo, publica o AI Elements: uma
biblioteca de componentes sobre shadcn/ui, distribuída pelo registry do shadcn.
Os componentes chegam como código-fonte no repositório e não exigem Next.js, o
que os torna utilizáveis no renderer do Electron.

## Decisões

### 1. A interface usa AI Elements como base

As famílias de código e de raciocínio cobrem a tela de execuções, que é a mais
trabalhosa: raciocínio colapsável, chamada de ferramenta com entrada e saída,
destaque de sintaxe, stack trace, acompanhamento de tarefa e indicador de
streaming.

Como os componentes entram como fonte, o tema e as modificações ficam no
repositório e não dependem de versão publicada de terceiro.

### 2. O chat interno é o gêmeo do servidor MCP

O aplicativo ganha um chat que opera o próprio produto: criar e editar agent,
cadastrar servidor MCP, disparar execução, consultar custo e explicar por que um
passo foi pulado.

Ele não tem catálogo próprio de ferramentas. Consome a mesma camada de serviço
que o servidor MCP consome, de modo que qualquer capacidade nova aparece nas
duas frentes de uma vez, sem implementação dobrada.

### 3. Aprovação nunca é ferramenta de modelo, nem no chat

Esta é a extensão da decisão 4 do ADR 0002 para dentro do aplicativo.

O assistente do chat lê conteúdo que não é confiável: diff de pull request,
corpo de achado, mensagem de Slack, log de produção. Se aprovar ou publicar
fosse ferramenta invocável pelo modelo, bastaria uma instrução escrita dentro de
um diff para que o assistente aprovasse e publicasse sozinho. A injeção de
prompt teria como alvo exatamente a garantia central do produto.

No chat, a aprovação aparece como componente renderizado a partir de uma parte
estruturada devolvida pelo modelo. O modelo propõe; o clique da pessoa executa.
Nenhum caminho de código permite que uma chamada de ferramenta resulte em
publicação.

### 4. O grafo de execução entra, o editor visual continua opcional

O AI Elements inclui uma família de workflow com canvas, nós, arestas, painel e
controles. Como o passo já declara `needs` desde o ADR 0001, o grafo de uma
execução pode ser renderizado sem mudança de modelo de dados.

A visualização somente leitura entra no M4. O editor visual deixa de ser
proibitivo, mas continua fora do escopo: cadeia curta de passos edita melhor em
lista, com diff legível entre versões.

Isto revisa a estimativa anterior, que assumia construir canvas do zero.

### 5. A ponte leva o clique, e o chat não pode alcançá-la

Emenda de 19 de setembro de 2026, escrita na revisão da casca Electron.

A ponte entre janela e serviços expõe `approvals.decide`, e isso está certo: é o
transporte do clique de uma pessoa no botão da inbox. O preload não tem canal
genérico, cada canal é declarado no contrato, e a decisão continua passando pela
ApprovalGate.

O risco não é a ponte, é o chat do M4 rodar no mesmo renderer. Se o catálogo de
ferramentas do assistente for montado a partir dos canais da ponte, ele ganha
`approvals.decide` de graça, e uma instrução plantada num diff volta a poder
publicar.

Regra para o M4: o catálogo do chat é lista explícita, nunca derivada dos canais
da ponte, e `approvals.decide` não entra nela. O componente de aprovação chama a
ponte direto, fora do alcance do modelo.

## Consequências

O renderer passa a depender de shadcn/ui e do registry do AI Elements. Como os
componentes são copiados para o repositório, não há dependência de rede em tempo
de execução, o que importa num aplicativo que precisa abrir sem conexão.

A camada de serviço do M1 ganha um segundo consumidor previsto desde já, o que
reforça a decisão de não deixar regra de cadastro fora dela.

O chat precisa de um provedor configurado para funcionar. Numa máquina com o
binário do Claude Code autenticado, ele usa esse runtime; caso contrário, cai na
tabela de fallback como qualquer outro passo.
