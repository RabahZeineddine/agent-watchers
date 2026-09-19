# Agent Watchers

Aplicativo pessoal para macOS que roda agents em segundo plano, prepara trabalho
enquanto você não está olhando e entrega o resultado numa fila de aprovação.
Nada que escreve fora sai sem um clique seu.

Primeiro caso de uso: revisão dos pull requests do time, com triagem e auditoria
em modelos diferentes, contexto de deploy cruzado do ArgoCD, e convenções da
time carregadas como skill conforme os arquivos alterados.

## Estado

O núcleo headless funciona e foi verificado de ponta a ponta. A casca Electron e
a interface ainda não existem; por enquanto tudo passa pela linha de comando,
com o mesmo executor que a interface vai usar.

```bash
cd app
npm install
npm run db:push
npm run dev seed
npm run dev demo     # pipeline completo num PR sintético, sem credencial
```

Detalhes em [docs/estado-atual.md](docs/estado-atual.md).

## Documentação

| documento | conteúdo |
|---|---|
| [ADR 0001](docs/adr/0001-arquitetura-v2.md) | as dez decisões de arquitetura e as alternativas descartadas |
| [decisoes-da-conversa.md](docs/decisoes-da-conversa.md) | o caminho até o desenho, incluindo o que mudou de ideia |
| [pesquisa.md](docs/pesquisa.md) | o que foi verificado na documentação externa, separado de suposição |
| [estado-atual.md](docs/estado-atual.md) | o que existe, o que falta, e as armadilhas encontradas |
| [ADR 0002](docs/adr/0002-camada-de-servico-e-servidor-mcp.md) | camada de serviço, servidor MCP próprio, e por que aprovação fica fora dele |
| [roadmap.md](docs/roadmap.md) | marcos M1 a M5, até o `.dmg` |
| [backlog.md](docs/backlog.md) | tarefas atômicas com critério de pronto e comando de verificação |
| [diario.md](docs/diario.md) | uma linha por iteração de execução |

## Estrutura

```
PROMPT.md       prompt do loop de execução autônoma
app/            núcleo em TypeScript, o produto daqui para a frente
docs/           decisões, pesquisa, estado e roadmap
app.py          versão anterior em Python, mantida só como referência
core/           idem
watchers/       idem
static/         idem
```

A versão em Python continua no repositório por enquanto para consulta. O gateway
de LLM, o cliente de LLM e as pontes MCP dela deixam de existir na v2, porque
são resolvidos por biblioteca. O que sobrevive em espírito é o armazenamento de
estado e os adaptadores de tracker, reescritos em TypeScript.
