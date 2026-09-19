# Locum

*Locum: quem assume o seu posto enquanto você não está.*

Aplicativo para macOS que roda os seus agents em segundo plano e faz o trabalho
no seu lugar. Ele revisa, investiga, correlaciona e escreve, e quanto do
resultado sai sozinho é decisão sua: cada ação tem modo de aprovação, rascunho
ou automático, destravado por categoria conforme a medição sustenta.

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

## Provedores e assinatura

O Locum roda com dois runtimes atrás da mesma interface. O nativo usa o AI SDK e
fala com qualquer provedor por chave de API: Anthropic, OpenAI, Google, GLM,
Groq, OpenRouter, Ollama e qualquer endpoint compatível com OpenAI.

O segundo runtime executa o binário do Claude Code já instalado e autenticado na
máquina de quem usa, o que permite aproveitar a própria assinatura em vez de
gastar chave de API. O Locum não embute login, não intermedeia credencial e não
redistribui acesso: quem usa autentica a própria ferramenta, na própria máquina.
Sem o binário instalado, esse runtime simplesmente não é oferecido, e a tabela
de fallback redireciona os passos afetados para provedores por chave.

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

## Idioma

O código usa identificadores em inglês. Comentários e documentação estão em
português enquanto o projeto é privado, e serão traduzidos antes da abertura do
repositório, junto com o guia de contribuição. A tarefa está no backlog.

## Licença

MIT. Veja [LICENSE](LICENSE).

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
