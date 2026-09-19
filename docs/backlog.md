# Backlog executável

Tarefas atômicas, em ordem. Cada uma tem critério de pronto e comando de
verificação. Uma tarefa por iteração do loop.

Marque `[x]` apenas depois que o comando de verificação passar. Os comandos
rodam a partir de `app/`; os caminhos de arquivo são relativos a `app/` também,
exceto os que começam com `docs/`.

## M1, camada de serviço

- [ ] **M1.1 AgentService**
  Criar `src/services/agent-service.ts` com `list()`, `get(agentId)`,
  `getLatestVersion(agentId)`, `upsert(spec, note)` criando versão imutável, e
  `listVersions(agentId)`. Mover para lá a lógica que hoje está em `seed()` no
  `cli.ts`.
  Pronto quando: `cli.ts` não monta mais linha de `agent_versions` diretamente.
  Verificação: `npx tsc --noEmit && npx tsx src/cli.ts seed`

- [ ] **M1.2 McpService e cadastro no banco**
  Criar `src/services/mcp-service.ts` com `list()`, `register(config)`,
  `remove(name)`, `setEnabled(name, bool)`. O `buildExecutor()` passa a ler a
  tabela `mcp_servers` em vez da constante vazia `mcpServers` no `cli.ts`.
  Pronto quando: a constante `mcpServers` sumir do `cli.ts`.
  Verificação: `npx tsc --noEmit && npx tsx src/cli.ts demo` continua pulando o
  passo de contexto de deploy com o motivo registrado.

- [ ] **M1.3 McpService: testar conexão e listar ferramentas**
  Acrescentar `testConnection(name)` devolvendo status e erro, e
  `listTools(name)` devolvendo nome, descrição e uma estimativa de tokens do
  schema de cada ferramenta.
  Pronto quando: existir comando `npx tsx src/cli.ts mcp:tools <nome>`.
  Verificação: cadastrar um servidor stdio simples e listar as ferramentas dele.

- [ ] **M1.4 ProviderService**
  Criar `src/services/provider-service.ts` com `listProviders()` informando
  disponibilidade nesta máquina, `getFallbacks(machineId)`,
  `setFallback(machineId, from, to, order)` com detecção de ciclo na gravação, e
  `resolvePreview(model, machineId)` para mostrar na interface o que aquele
  passo vira aqui.
  Pronto quando: `resolveModel` não for mais chamado direto pelo `cli.ts`.
  Verificação: `npx tsc --noEmit && npx tsx src/cli.ts providers`

- [ ] **M1.5 RunService**
  Criar `src/services/run-service.ts` com `list(filtro)`, `get(runId)` trazendo
  os passos, `findings(runId)`, e `rerunStep(runId, stepKey)` que zera o passo e
  os que dependem dele antes de reexecutar.
  Pronto quando: `printRun` no `cli.ts` consumir o serviço.
  Verificação: `npx tsc --noEmit && npx tsx src/cli.ts run <id-existente>`

- [ ] **M1.6 ApprovalService**
  Extrair da `ApprovalGate` a parte de consulta: `listPending()`,
  `get(approvalId)`. A decisão continua na `ApprovalGate`, que permanece o único
  caminho de publicação.
  Pronto quando: `inbox` no `cli.ts` consumir o serviço.
  Verificação: `npx tsc --noEmit && npx tsx src/cli.ts inbox`

## M2, servidor MCP próprio

- [ ] **M2.1 Esqueleto do servidor**
  Criar `src/mcp-server/index.ts` usando o SDK oficial de MCP, transporte stdio,
  abrindo o mesmo banco. Adicionar script `mcp` no `package.json`.
  Pronto quando: o servidor sobe e responde a `tools/list` com lista vazia.
  Verificação: `npx tsc --noEmit && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx src/mcp-server/index.ts`

- [ ] **M2.2 Ferramentas de leitura**
  `list_agents`, `get_agent`, `list_runs`, `get_run`, `list_findings`,
  `get_metrics`, `list_mcp_servers`, `list_providers`, `get_machine_profile`.
  Pronto quando: `tools/list` devolver as nove e cada uma responder.
  Verificação: `npx tsc --noEmit`

- [ ] **M2.3 Ferramentas de configuração**
  `upsert_agent`, `register_mcp_server`, `test_mcp_server`, `list_server_tools`,
  `set_model_fallback`, `set_budget`, `set_trigger`. Toda escrita valida a
  entrada com o zod de `src/config/types.ts` e devolve erro legível.
  Pronto quando: `upsert_agent` com spec inválido devolver a mensagem do zod e
  não gravar nada.
  Verificação: `npx tsc --noEmit`

- [ ] **M2.4 Ferramentas de execução**
  `run_agent` aceitando alvo real (`owner/repo#numero`) ou sintético, e
  `rerun_step`.
  Pronto quando: `run_agent` com alvo sintético produzir execução e devolver o
  identificador.
  Verificação: `npx tsc --noEmit`

- [ ] **M2.5 Registro no repositório**
  Criar `.mcp.json` na raiz apontando para o servidor, para que um assistente
  externo o carregue ao abrir o projeto.
  Pronto quando: o arquivo existir e for válido.
  Verificação: `node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8'))"`

- [ ] **M2.6 Documentar a fronteira**
  Escrever `docs/mcp-server.md` listando cada ferramenta, o que ela faz, e a
  seção explicando por que aprovação e publicação não estão lá.
  Pronto quando: o arquivo existir e cobrir todas as ferramentas implementadas.

## Núcleo, pendências que não bloqueiam os marcos

- [ ] **N.1 Reconciliador de review humano**
  `src/sources/github-reconciler.ts`: ao fechar um pull request, puxar reviews
  humanos, casar por arquivo e linha com os achados, comparar o diff final e
  preencher `finding_outcomes` e `review_signals`.
  Pronto quando: rodar contra uma execução existente e gravar desfechos.

- [ ] **N.2 Métricas por versão**
  Agregar `agent_metrics` a partir de `finding_outcomes`, guardando o conjunto
  de skills junto da versão.
  Pronto quando: `npx tsx src/cli.ts metrics` imprimir precisão por versão.

- [ ] **N.3 Agendador**
  `src/triggers/scheduler.ts` com cursor de tempo, sem `setInterval` de janela
  fixa, preparado para receber o evento de acordar da máquina no M3.
  Pronto quando: duas execuções seguidas não reprocessarem o mesmo evento.

## M3 em diante

Não quebrados em tarefas ainda. Quebrar ao chegar, com o mesmo formato.

- [ ] M3 casca Electron
- [ ] M4 interface
- [ ] M5 empacotamento
