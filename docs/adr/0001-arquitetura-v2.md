# ADR 0001: Arquitetura v2 do Agent Watchers

Data: 2026-09-19
Status: aceito
Substitui: a implementação Python em `app.py`, `core/` e `watchers/`

## Contexto

A primeira versão é um serviço FastAPI em Python com UI servida em localhost. Ela
reimplementa à mão três coisas que hoje existem prontas: um gateway de LLM com
fallback entre provedores, pontes MCP específicas para Slack e GitHub, e o loop
de execução do watcher de PR.

O objetivo mudou de escopo. O que se quer agora é um aplicativo pessoal para
macOS que roda agents em segundo plano, prepara trabalho enquanto o usuário não
está olhando e entrega o resultado numa fila de aprovação. Os agents precisam
acessar servidores MCP locais e remotos, usar modelos de provedores diferentes
no mesmo pipeline, e funcionar em duas máquinas com condições distintas: uma com
assinatura Claude Max, outra apenas com chaves de API.

## Decisões

### 1. Aplicativo desktop, não servidor em localhost

A execução fica na máquina do usuário e isso não é negociável: servidor MCP por
stdio é processo local, os repositórios são locais, o binário do Claude Code que
carrega a assinatura é local, e as credenciais pertencem ao keychain do sistema.

Uma aba de navegador não entrega bandeja, início automático no login, cofre de
credencial, deep link para OAuth nem notificação com ação. O aplicativo entrega.

Escolha: Electron. O processo principal é Node, então o daemon e a interface
vivem no mesmo processo, sem sidecar. Tauri exigiria empacotar um runtime Node
como binário externo e conversar por IPC, complexidade que só se paga quando o
tamanho do binário importa.

### 2. Dois runtimes atrás de uma interface

Assinatura é propriedade do harness, não do provedor. Nenhum cliente de API
entrega cota de assinatura. A consequência é que existem duas vias:

- runtime nativo, construído sobre o AI SDK v6, para qualquer provedor por chave
  de API. É o padrão.
- runtime `claude-code`, um adaptador sobre `claude -p`, única forma de gastar a
  cota da assinatura Max.

Os dois implementam a mesma interface e emitem o mesmo fluxo de eventos. O
executor não sabe qual está rodando.

O adaptador nunca usa `--bare`, porque esse modo ignora o login de assinatura.
Como consequência ele carrega as configurações pessoais do usuário, incluindo
hooks de sessão que alteram o estilo da saída. A proteção é pedir saída
estruturada com `--json-schema`, que independe de estilo.

### 3. Motor de agent: AI SDK v6 como biblioteca

O AI SDK entrega quatro peças que seriam reescritas à mão: registro de provedores
com alias e fallback, cliente MCP com transporte stdio, http e sse, laço de
ferramentas, e saída estruturada validada.

Não usamos o `WorkflowAgent` do pacote `@ai-sdk/workflow`. Ele é Apache 2.0 e
self-hostável, mas o transform de build é documentado para Next.js e a
persistência de verdade é Postgres. Peso que um aplicativo desktop não paga.

A durabilidade fica por conta de uma máquina de estado própria em SQLite, atrás
de uma interface pequena, para que essa decisão possa ser revista sem tocar no
resto.

### 4. Banco como fonte da verdade, git como exportação

A configuração é autorada na interface e gravada em SQLite. Não há YAML escrito à
mão.

Cada gravação cria uma versão imutável do agent, e cada execução aponta para a
versão exata que rodou. Isso permite abrir uma execução de três semanas atrás e
ver o pipeline como ele era, coisa que arquivo em disco não entrega sem
reimplementar controle de versão dentro do aplicativo.

A exportação para uma pasta versionada em git existe como recurso, numa via só,
do banco para o disco. A importação é ação explícita.

### 5. Modelo concreto no passo, fallback por máquina

O passo declara o modelo real, não um papel abstrato. A portabilidade entre
máquinas é resolvida por uma tabela de fallback nas preferências, consultada
apenas quando o modelo escolhido não está disponível naquela máquina.

A tabela é local e não vai para o git. A execução grava modelo pedido, modelo
usado e motivo da substituição.

### 6. Ferramentas por passo, herdadas do agent

O agent define um conjunto padrão de ferramentas e o passo herda. O passo declara
apenas quando quer algo diferente.

A seleção é por ferramenta, não por servidor. Habilitar um servidor MCP inteiro
coloca dezenas de schemas no contexto a cada chamada, o que custa tokens e piora
a escolha do modelo.

Toda ferramenta recebe uma classe: leitura, escrita interna e escrita externa.
Escrita externa sempre passa pela fila de aprovação, independente de
configuração de herança.

Credenciais de nuvem entram no aplicativo com permissão de leitura configurada na
origem, na própria IAM e no Azure, e não apenas desmarcadas na interface.

### 7. Skills por regra de arquivo

Skills existentes são reaproveitadas do acervo do usuário e dos plugins, sem
formato novo. A seleção é por regra determinística sobre os arquivos alterados
no evento, não por lista fixa por agent.

No runtime `claude-code` o carregamento é nativo. No runtime nativo usamos
divulgação progressiva: apenas nome e descrição entram no prompt, e uma
ferramenta carrega o corpo sob demanda.

A execução grava o hash do conteúdo de cada skill usada, sem o que a métrica de
qualidade mente quando uma skill externa é atualizada.

### 8. Ingestão determinística, exploração por ferramenta

Pergunta conhecida de antemão vira busca determinística injetada no prompt.
Pergunta que nasce durante o raciocínio vira ferramenta MCP.

As fontes de evento têm três implementações atrás da mesma interface: SDK nativo
com varredura, webhook, e consulta a servidor MCP. A terceira existe para
ambientes onde não é possível registrar aplicativo, caso comum de Slack e Teams
corporativos.

A varredura é por cursor de tempo, nunca por intervalo fixo, porque intervalo
morre quando a máquina dorme. O aplicativo escuta os eventos de energia do
sistema e recupera a janela perdida ao acordar.

### 9. Aprovação com três modos

Cada ação declara um modo: aprovar, rascunho ou automático.

O padrão de escrita externa é aprovar. O modo rascunho prepara o resultado sem
publicar, usando quando possível o próprio mecanismo do destino, como a review
em estado pendente do GitHub, visível apenas para quem a criou.

O modo automático existe mas nasce desligado, é escopado por categoria e
repositório, e a interface só o oferece quando as métricas de precisão coletadas
sustentam a decisão.

### 10. Medição a partir do review humano

O sinal de qualidade não vem de opinião registrada no momento, vem do que
aconteceu depois: o que revisores humanos apontaram no mesmo trecho, o que eles
apontaram e o agent não viu, e se o achado resultou em alteração de código.

Um reconciliador roda quando o pull request fecha, cruza os dados e preenche os
desfechos. As métricas ficam agregadas por versão de agent e por conjunto de
skills.

Correções humanas recorrentes viram proposta de regra na fila de aprovação. Uma
vez aceitas, passam a compor uma skill de convenções, carregada como qualquer
outra.

## Consequências

O código Python atual é substituído. Sobrevive pouco: o armazenamento de estado e
os adaptadores de tracker, que serão reescritos em TypeScript. O gateway de LLM,
o cliente de LLM e as pontes MCP deixam de existir.

O aplicativo passa a depender do binário do Claude Code para a via de assinatura.
Na máquina sem assinatura, essa via simplesmente não é oferecida, e a tabela de
fallback cobre os passos afetados.

Servidores MCP sobem sob demanda e são encerrados após período ocioso, para que a
quantidade de servidores cadastrados não determine o consumo de memória em
repouso.

## Alternativas consideradas

Adotar n8n como plano de automação, com os agents chamados por HTTP e workflows
publicados como ferramentas MCP. Descartado porque o objetivo é um produto
próprio, e porque a licença fair-code do n8n limita distribuição futura.

Adotar o opencode como runtime único. Descartado porque a documentação dele
declara que não suporta Claude Pro e Max, o que deixaria a máquina com assinatura
sem uso, e porque o controle fino sobre aprovação e telemetria de custo é o
núcleo do produto.

Adotar o Workflow DevKit para durabilidade. Adiado, não descartado. A interface
do executor mantém a porta aberta.
