# Registro da conversa de desenho

Sessão de 18 e 19 de setembro de 2026. Este arquivo guarda o caminho até o
desenho atual, incluindo o que foi descartado e o que mudou de ideia no meio.
O resultado final está no ADR 0001; aqui fica o porquê, que o ADR não carrega.

## O ponto de partida

A v1 era um serviço FastAPI em Python com UI em localhost, um gateway de LLM
próprio, pontes MCP escritas à mão para Slack e GitHub, e o watcher de PR com
loop próprio.

O pedido inicial: rodar agents customizados que conversam com MCP local ou
remoto, revisar PRs, sincronizar tarefas, acompanhar aplicações, usar provedores
remotos, e se possível usar a assinatura Claude em vez de chave de API. Junto
veio a dúvida de fazer aplicativo em vez de localhost.

## Achados de pesquisa que mudaram o desenho

**Assinatura é propriedade do harness, não do provedor.** Nenhum cliente de API
entrega cota de assinatura. A cota Max só sai pelo binário do Claude Code, a do
plano ChatGPT pelo `codex exec`, a do Google pelo Gemini CLI. A documentação do
modo headless confirma: `--bare` acelera a inicialização mas ignora o login de
assinatura e passa a exigir `ANTHROPIC_API_KEY`. Logo, quem quer assinatura não
usa `--bare`.

**A política da Anthropic restringe terceiros.** A página de visão geral do
Agent SDK diz que, sem aprovação prévia, desenvolvedores terceiros não podem
oferecer login claude.ai nem os limites de taxa dele em seus produtos. Uso
pessoal na própria máquina é o próprio Claude Code rodando com a sessão do
usuário. Distribuição futura exige que cada pessoa traga a própria credencial.

**O opencode não roda Claude Pro nem Max.** A documentação de provedores deles
declara isso explicitamente. Suporta ChatGPT Plus e GitHub Copilot por OAuth, e
mais de 75 provedores por chave de API através do AI SDK e do models.dev. Esse
único fato tirou o opencode da posição de runtime único.

**O Workflow DevKit é Apache 2.0 e self-hostável.** Minha primeira avaliação
disse que era preso à Vercel, e estava errada. A durabilidade fica atrás de uma
abstração chamada World, com implementação de referência em Postgres. O que
pesa contra no nosso caso é outra coisa: o transform de build é documentado para
Next.js, e o self-host real é Postgres, peso que um aplicativo desktop não paga.

## Decisões que mudaram no meio da conversa

**Claude como espinha, depois como uma via.** A primeira proposta girava tudo em
torno do Agent SDK. O pedido foi explícito em querer múltiplos provedores, então
o desenho passou a ter duas vias atrás de uma interface: runtime nativo sobre o
AI SDK para qualquer provedor por chave, e adaptador `claude -p` só para a cota
de assinatura.

**opencode como base, depois removido.** Chegou a ser recomendado como runtime
por facilitar instalação de MCP e contribuição de terceiros. Saiu quando ficou
claro que o objetivo é um produto próprio com interface própria, e porque
aprovação e telemetria de custo são o núcleo, não algo a terceirizar.

**n8n como plano de automação, depois removido.** A ideia de usar o n8n para
gatilhos e conectores, com workflows publicados como ferramentas MCP, era
tecnicamente boa: os mais de 400 conectores virariam catálogo de tools sem
escrever servidor MCP. Saiu porque o objetivo é construir o produto, não montar
integração entre plataformas de terceiros, e porque a licença fair-code limita
distribuição futura.

**Papel abstrato no passo, depois modelo concreto.** O desenho usava papéis
(rápido, raciocínio) resolvidos por um perfil de máquina. Foi descartado por
indireção: olhar o passo não dizia qual modelo rodava. Trocado por modelo
concreto no passo mais uma tabela de fallback por máquina, consultada apenas
quando o modelo não existe ali. A tabela é local e não vai para o git.

**Ferramenta por passo, depois herdada do agent.** Selecionar ferramenta em cada
passo é seguro mas cansativo. Virou herança: o agent define o conjunto padrão e
o passo só declara quando quer diferente. A classe de escrita externa continua
travada em aprovação, independente de herança.

**Canvas visual.** Avaliado três vezes e recusado três vezes, sempre pelo mesmo
motivo: os pipelines são cadeias curtas e lineares, e lista edita mais rápido,
com diff legível entre versões. O que ficou da ideia: o passo ganhou `needs`, de
modo que o modelo de dados já é um grafo e um editor visual pode entrar depois
sem migração. Visualização somente leitura da execução continua prevista.

## Princípios que sobreviveram a tudo

**Ingestão determinística, exploração por ferramenta.** Pergunta conhecida de
antemão vira busca em código, injetada no prompt. Pergunta que nasce durante o
raciocínio vira ferramenta MCP. É o que separa um custo de dezenas de dólares
por mês de um de centenas.

**Nada sai sem clique.** Regra pessoal do dono do repositório, que virou
arquitetura: escrita externa é sempre passo de ação, passa pela fila, e o
`externalId` é gravado antes da chamada para que retry não publique duas vezes.
O modo automático existe, nasce desligado, é escopado por categoria e
repositório, e só deve ser oferecido quando a medição sustentar.

**O agent prepara, não resolve.** O ganho prometido não é acordar com o trabalho
feito, é acordar com ele preparado e gastar quinze minutos aprovando.

**Medir com gabarito humano, não com opinião.** Polegar registrado no momento é
fraco. O sinal forte é o que aconteceu depois: o que revisores humanos
apontaram no mesmo trecho, o que apontaram e o agent não viu, e se o achado
resultou em alteração de código.

## Riscos aceitos conscientemente

1. **Escopo.** O maior de todos. O antídoto combinado foi cortar a v1 em um único
   watcher e resistir à vontade de construir a plataforma antes.
2. **Sinal fraco.** Se o agent gritar lobo, o uso morre em duas semanas. Por isso
   o reconciliador e as métricas entram cedo, não depois.
3. **Acesso corporativo.** Teams por Graph e Slack por token dependem do TI. Não
   é risco técnico. A mitigação é a fonte por consulta a MCP, que funciona em
   ambiente onde não se pode registrar aplicativo.
4. **Concorrência.** Revisão de PR com IA já existe em vários produtos. O que
   justifica este é o contexto cruzado: deploy no ArgoCD, incidente no New Relic,
   convenção da time em skill própria. O passo de contexto de deploy não é
   enfeite, é a razão do projeto.
5. **Manutenção.** Provedor muda, MCP muda, flag do Claude Code muda. É meia hora
   por mês, para sempre.

## Verificado durante a sessão

O pipeline rodou de ponta a ponta contra um evento sintético com quatro defeitos
plantados em C#, usando a assinatura pelo adaptador `claude -p`. Os quatro foram
encontrados: `DateTime.Now` no lugar de `UtcNow`, `Dictionary` no lugar de
`ConcurrentDictionary` em cache concorrente, `.Result` sobre método assíncrono, e
`ContainsKey` seguido de `Add` sem atomicidade.

Três comportamentos do desenho se confirmaram sem intervenção: passo opcional com
servidor MCP ausente foi pulado com motivo registrado, passo de ação parou o run
e criou a pendência na fila, e a retomada não reexecutou os passos concluídos.

Dois defeitos foram encontrados e corrigidos no caminho. O orçamento contava o
equivalente em dólar reportado pelo `claude -p` como dinheiro gasto, quando na
assinatura o gasto marginal é cota; a separação virou `runs.cost_usd` para
dinheiro e `runs.estimate_usd` para equivalente, com `billable` por passo.
E orçamento estourado marcava o run como falho, quando o certo é pausar e
esperar decisão.
