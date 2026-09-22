# Pesquisa externa verificada

O que foi conferido na documentação durante o desenho, separado do que é
suposição. Datado de setembro de 2026; vale reconferir antes de decidir de novo.

## Claude Agent SDK e Claude Code

- Disponível como biblioteca em Python e TypeScript. Para outras linguagens, a
  saída é rodar a CLI como subprocesso com `-p` e `--output-format json`.
- Capacidades expostas: ferramentas embutidas, hooks, subagents, MCP, permissões,
  sessões, skills e comandos carregados de `.claude/` e `~/.claude/`, plugins.
- Restrição de política, na página de visão geral: sem aprovação prévia, a
  Anthropic não permite que desenvolvedores terceiros ofereçam login claude.ai
  nem os limites de taxa dele em seus produtos, incluindo agents construídos
  sobre o Agent SDK.
- Fonte: code.claude.com/docs/en/agent-sdk/overview

## Modo headless

- `--bare` reduz o tempo de inicialização pulando descoberta de hooks, skills,
  comandos, subagents, plugins, MCP e CLAUDE.md. Em contrapartida não lê
  credencial OAuth nem keychain, e passa a exigir `ANTHROPIC_API_KEY`.
- Consequência para nós: a via de assinatura não pode usar `--bare`. O
  isolamento sai de outras três flags, que mantêm o login: `--setting-sources ""`
  (sem hooks, plugins, regras e CLAUDE.md pessoais), `--strict-mcp-config` e
  `--no-session-persistence`. Conferido na versão 2.1.280 com `apiKeySource`
  igual a `none` na mensagem de início.
- `--output-format json` traz `result`, `structured_output`, `total_cost_usd`,
  `session_id` e uso. O custo é estimativa do lado do cliente.
- Continuação por `--continue` ou `--resume <id>`, e o id é encontrado em
  qualquer projeto da máquina.
- Fonte: code.claude.com/docs/en/headless

## MCP no Agent SDK

- Transportes: stdio, http e sse. Configuração em código ou em `.mcp.json`.
- O SDK não abre navegador nem roda fluxo OAuth. Servidor que exige autorização
  volta com status `needs-auth`; quem faz o fluxo e injeta o token no header é a
  aplicação.
- Ferramentas MCP seguem `mcp__<servidor>__<ferramenta>` e precisam de permissão
  explícita, preferencialmente por `allowedTools` com curinga por servidor.
- Limite de saída de ferramenta: 25 mil tokens, ajustável por
  `MAX_MCP_OUTPUT_TOKENS`.
- Fonte: code.claude.com/docs/en/agent-sdk/mcp

## AI SDK da Vercel

- Pacote `ai`, open source. É o que o opencode usa por baixo para chegar aos mais
  de 75 provedores.
- `createProviderRegistry` e `createOpenAICompatible` cobrem roteamento por
  string, alias de modelo, middleware de configuração padrão e provedor de
  fallback.
- `createMCPClient` no pacote `@ai-sdk/mcp`, com transporte stdio via
  `Experimental_StdioMCPTransport`, e http e sse por configuração direta, com
  `headers` e `authProvider` para OAuth.
- O laço de ferramentas para com `stopWhen`. O nome real do helper de contagem de
  passos é `stepCountIs`, não `isStepCount`, detalhe que só apareceu ao compilar.
- Aprovação humana: `needsApproval` existe no `WorkflowAgent`; em `generateText`,
  `streamText` e `ToolLoopAgent` o mecanismo é `toolApproval`.
- Versões instaladas na sessão: `ai` 6.0.286, `@ai-sdk/mcp` 1.0.82.

## Workflow DevKit

- Licença Apache 2.0, repositório vercel/workflow, em beta público.
- Durabilidade atrás de uma abstração chamada World. Desenvolvimento local usa um
  backend embutido; self-host de verdade é Postgres, com implementação de
  referência publicada, e existem Worlds de terceiros.
- O suporte de framework documentado no repositório é Next.js, com
  `withWorkflow`. Não há World de SQLite oficial.
- Conclusão para nós: adiado, não descartado. O executor fica atrás de interface.

## opencode

- Mais de 75 provedores via AI SDK e models.dev. Credenciais em
  `~/.local/share/opencode/auth.json`.
- Declara explicitamente que não suporta Claude Pro e Max. Suporta ChatGPT
  Plus/Pro e GitHub Copilot por OAuth.
- `opencode serve` sobe servidor HTTP com OpenAPI 3.1, SDK gerado, e fluxo de
  eventos por SSE em `/event`.
- Agent por JSON ou markdown, com modelo próprio por agent, distinção entre
  primário e subagent, delegação pelo Task tool com allowlist, e permissões com
  valores allow, ask e deny.
- MCP local com `{"type":"local","command":[...]}` e remoto com
  `{"type":"remote","url":...}`, ambos com `enabled` e `timeout`.

## n8n

- Licença fair-code, self-host disponível.
- Tem nó MCP Client Tool para consumir servidores MCP, e MCP Server Trigger para
  expor workflows do n8n como ferramentas MCP a agents externos.
- A funcionalidade própria de Agents está em Preview no self-hosted.
