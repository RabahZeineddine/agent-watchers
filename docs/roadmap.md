# Roadmap

## v1, núcleo do review de PR

Objetivo: uma coisa funcionando de verdade, ponta a ponta, útil sozinha.

- [x] esquema do banco e versão imutável de agent
- [x] executor durável com retomada e orçamento
- [x] runtime nativo e runtime de assinatura
- [x] registro MCP sob demanda
- [x] skills por regra de arquivo
- [x] fila de aprovação
- [x] fonte GitHub e ação de review
- [ ] cadastro de MCP vindo do banco
- [ ] reconciliador de review humano e métricas
- [ ] agendador com cursor e eventos de energia

## v2, assinatura como segundo runtime

Já implementado antes do previsto. Resta o adaptador `codex exec` para usar o
plano ChatGPT na máquina sem assinatura Claude.

## v3, interface

Bandeja, início automático, keychain, deep link de OAuth, notificação com ação.
Quatro telas: inbox, execuções, agents, configuração. Visualização somente
leitura da execução. Exportação para pasta versionada em git.

## v4, radar de Slack e Teams

Digest em vez de notificação item a item. Depende de acesso corporativo, que não
é risco técnico. A fonte por consulta a MCP existe para o caso de o registro de
aplicativo não sair.

É o teste do desenho: se este watcher entrar sem tocar no núcleo, a arquitetura
está certa.

## v5, incidente

Alarme do New Relic como gatilho determinístico. O agent entra depois do alarme
para correlacionar deploy, trace e pull request recente, e entregar a hipótese.

## v6, o resto

Jira, deploy, watcher dos próprios pull requests. Cada um é configuração mais
uma fonte, não código novo.

## Fora de escopo, de propósito

- editor visual de nós, enquanto os pipelines forem cadeias curtas
- agent agindo sozinho em escrita externa sem destravamento medido
- modelo vigiando log continuamente
- multiusuário, nuvem, time
- Windows e Linux
