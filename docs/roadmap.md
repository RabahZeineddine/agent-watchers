# Roadmap

Ordem revisada pelo ADR 0002: o servidor MCP vem antes da interface, porque é o
que torna o produto configurável enquanto não há tela.

## Pendências pequenas do núcleo

Absorvidas pelos marcos abaixo, listadas aqui para não sumirem.

- cadastro de servidores MCP vindo do banco, hoje uma lista vazia em `src/cli.ts`
- reconciliador de review humano e coleta de métricas
- agendador com cursor e escuta de eventos de energia

## M1, camada de serviço

`AgentService`, `McpService`, `ProviderService`, `RunService` e
`ApprovalService`. Linha de comando passa a ser casca fina.

Pronto quando a linha de comando não tiver mais nenhuma regra de cadastro e o
`demo` continuar passando.

Estimativa: um fim de semana.

## M2, servidor MCP próprio

Transporte stdio sobre o mesmo banco. Ferramentas de leitura, configuração e
execução. Aprovação e publicação ficam de fora, por decisão do ADR 0002.

Pronto quando um assistente externo conseguir cadastrar um servidor MCP, montar
um agent e disparar uma execução sem tocar no código.

Estimativa: um fim de semana.

## M3, casca Electron

Processo principal carregando o núcleo, bandeja, início automático,
`powerMonitor`, `safeStorage` para credencial, notificação com ação, deep link
para OAuth.

Pronto quando o aplicativo ficar na bandeja, sobreviver ao sono da máquina e
notificar uma pendência.

Estimativa: um a dois fins de semana.

## M4, interface

Construída sobre AI Elements, por decisão do ADR 0003. Quatro telas: inbox,
execuções, agents, configuração. Mais o chat interno, que opera o produto pela
mesma camada de serviço que o servidor MCP usa.

A tela de execuções aproveita as famílias de código e raciocínio: chamada de
ferramenta com entrada e saída, destaque de sintaxe, stack trace, streaming. O
grafo da execução, somente leitura, sai barato porque o passo já declara `needs`.

Aprovação aparece como botão renderizado, nunca como ferramenta invocável pelo
modelo, porque o assistente lê conteúdo não confiável.

Pronto quando der para aprovar um achado sem abrir o terminal, e pedir ao chat
que crie um agent novo.

Estimativa: dois a três fins de semana, possivelmente menos com os componentes
prontos.

## M5, empacotamento

`electron-builder`, ícone, `.dmg`. Módulo nativo recompilado para o runtime do
Electron. Assinatura e notarização ficam condicionadas a conta de desenvolvedor
Apple; sem ela o aplicativo roda com aviso na primeira abertura e a atualização
automática não funciona.

Pronto quando existir um `.dmg` que instala e abre em uma máquina limpa.

Estimativa: um fim de semana, mais o tempo da conta Apple se você quiser
assinatura.

## Depois do aplicativo

**Radar de Slack e Teams.** Digest em vez de notificação item a item. Depende de
acesso corporativo, que não é risco técnico. A fonte por consulta a MCP existe
para o caso de o registro de aplicativo não sair. É o teste do desenho: se este
watcher entrar sem tocar no núcleo, a arquitetura está certa.

**Incidente.** Alarme do New Relic como gatilho determinístico, com o agent
entrando depois para correlacionar deploy, trace e pull request recente.

**Adaptador `codex exec`.** Plano ChatGPT como terceira via, para a máquina sem
assinatura Claude.

**O resto.** Jira, deploy, watcher dos próprios pull requests. Cada um é
configuração mais uma fonte, não código novo.

## Fora de escopo, de propósito

- editor visual de nós, enquanto os pipelines forem cadeias curtas. O canvas
  do AI Elements torna isso viável depois do M4, mas a lista continua sendo o
  editor principal
- agent agindo sozinho em escrita externa sem destravamento medido
- modelo vigiando log continuamente
- multiusuário, nuvem, time
- Windows e Linux
