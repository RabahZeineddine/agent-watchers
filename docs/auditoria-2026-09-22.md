# Auditoria de 22 de setembro de 2026

Revisão do Locum depois de 59 stories, feita lendo o código e não a lembrança do
que foi construído. Cada item cita onde está. A régua de "o que ficou para trás"
é o código Python original, que continua no repositório.

Os itens estão em ordem de gravidade dentro de cada seção.

## A. Defeitos de correção

### A1. O run nunca termina depois da aprovação

`ApprovalGate.decide` publica e fecha a pendência, e para aí. Ninguém passa o
passo de `awaiting_approval` para `done`, e ninguém retoma a execução. Se alguém
chamar `resume`, o executor encontra o passo em `awaiting_approval` e pausa de
novo (`src/executor/executor.ts:104`).

Consequências:

- toda execução de review fica `paused` para sempre, mesmo aprovada e publicada
- a tela de execuções mostra "1 aguardando" em execução que já saiu
- passo que venha depois de uma ação nunca roda
- rejeitar tem o mesmo efeito

Passou despercebido porque todo teste de fumaça confere o estado pausado e
nenhum confere o estado depois da decisão.

### A2. O orçamento não protege contra nada

Dois defeitos somados desligam os dois tetos.

O runtime nativo devolve custo zero sempre (`src/runtimes/native.ts:52`). O
runtime de assinatura já não conta como dinheiro, então nenhum provedor por
chave de API, que é justamente o que cobra, faz o teto por execução disparar.

O gasto diário só é gravado quando a execução chega a `done`
(`src/executor/executor.ts:140`). O fluxo normal de review termina em pausa, e a
pausa retorna antes dessa linha. O teto diário nunca recebe um centavo.

Um laço de varredura mal configurado num provedor pago gasta sem limite.

### A3. O diff vai inteiro para o modelo

Não existe limite de tamanho em `src/sources/github.ts`. Pull request com
arquivo de lock, código gerado ou migração grande manda centenas de milhares de
tokens para o modelo mais caro do pipeline. A versão Python cortava em 200 mil
caracteres.

### A4. A edição da revisão aceita trocar o destino

`ApprovalService.updatePayload` substitui o payload inteiro pelo que a janela
mandar (`src/services/approval-service.ts`). A tela só pretende editar os
achados, mas o serviço aceita também `owner`, `repo` e `pull`. Um defeito na
janela redirecionaria a publicação para outro pull request, e a pessoa aprovaria
achando que é o que está na tela.

Defesa em profundidade: o serviço aceita só a lista de achados, valida cada um,
e mantém o alvo gravado pelo executor.

### A5. O teste de fumaça grava no banco de verdade

`npm run smoke` na árvore principal usa o banco real e deixa pendência sintética
na inbox. Foi a origem da linha "PR Review, passo Comentar no PR" que apareceu
misturada com dado real. O loop isola isso com banco de rascunho; a verificação
manual não.

## B. Desempenho

### B1. O Claude Code sobe com a configuração pessoal inteira

O adaptador não isola o processo (`src/runtimes/claude-code.ts`). Cada passo de
modelo sobe o Claude Code carregando os hooks, as regras pessoais, os plugins e
os servidores MCP da máquina: 3 globais e 16 do plugins, incluindo os de
produção.

Isso explica 62 segundos de triagem num diff de dois arquivos, quase tudo
conexão de servidor. Cada execução também grava uma sessão no histórico pessoal.

Hoje as ferramentas de produção carregam mas não executam, porque não há regra
de liberação e o adaptador passa `--permission-prompts none`. A proteção é
frágil: uma regra de liberação acrescentada para uso diário abriria a ferramenta
para um agent que lê diff de terceiro.

As flags existem: `--strict-mcp-config`, `--setting-sources` e
`--no-session-persistence`. Falta verificar se `--setting-sources` mantém o login
de assinatura, porque `--bare` não mantém.

### B2. Todo servidor MCP fecha no fim de cada execução

O `finally` do executor chama `closeAll` (`src/executor/executor.ts:156`). Isso
desfaz o pool com encerramento por ocioso que o registro MCP foi desenhado para
ter, e cada execução sobe tudo de novo.

### B3. A varredura refaz o trabalho a cada batida

Em `src/sources/github.ts`:

- a consulta usa granularidade de dia (`updated:>=AAAA-MM-DD`, linha 111), então
  toda batida devolve tudo que mudou hoje
- `fetchPr` roda antes da deduplicação (linha 122), buscando diff completo de
  pull request já processado
- página de 50 sem paginação (linha 112): organização com mais de 50 pull
  requests movimentados num dia perde o resto em silêncio
- o filtro de repositório acontece depois da busca, varrendo a organização
  inteira
- rascunho não é pulado, e review de trabalho em andamento é dinheiro perdido

### B4. A lista de execuções faz 501 consultas

A tela pede 500 execuções (`renderer/src/telas/execucoes.tsx:56`) e o serviço
busca os passos de cada uma (`src/services/run-service.ts:102`). Regressão
introduzida no passe de design, quando a linha passou a mostrar andamento.

### B5. A inbox faz uma ida à ponte por pendência

Os achados de cada item vêm numa chamada separada
(`renderer/src/telas/inbox.tsx:96`).

### B6. O histórico do assistente cresce sem limite

Cada mensagem reenvia a conversa inteira, com o resultado de toda ferramenta já
chamada (`electron/chat.ts:120`, `:143`). O custo cresce ao quadrado com o
comprimento da conversa, e não há compactação.

### B7. O agendador não protege contra batida sobreposta

Uma batida longa, somada ao evento de acordar da máquina, pode rodar duas vezes
ao mesmo tempo (`src/triggers/scheduler.ts`). O índice único de evento segura a
maior parte, mas a criação de execução para o mesmo evento tem janela entre a
checagem e a gravação.

## C. Qualidade do review

O prompt de auditoria atual tem quatro linhas (`src/seed/pr-review.ts`). O da
versão Python (`watchers/pr_reviewer/prompts.py`) era bem mais completo, e a
comparação mostra o que se perdeu.

### C1. Taxonomia de defeito

O antigo nomeava seis focos: regressão funcional, idempotência e concorrência,
segurança e autorização, erro engolido sem registro, quebra de contrato de API
ou esquema, e lacuna de teste em caminho crítico. O atual diz "defeito real de
correção", que na prática deixa segurança, contrato e teste de fora.

### C2. Veredito

O antigo terminava em `APPROVE`, `COMMENT` ou `REQUEST_CHANGES`, com critério
para cada um. O atual não tem veredito, então a review sempre sai como
comentário e nunca pede mudança.

Pedir mudança ou aprovar em pull request de outra pessoa é ação forte: continua
passando pela fila.

### C3. Rubrica de severidade

O modelo escolhe crítico, alto, médio ou baixo sem definição. É por isso que
editar severidade virou recurso da tela de revisão. Uma rubrica curta no prompt
resolve na origem.

### C4. A auditoria não recebe a intenção do pull request

Título e descrição só entram na triagem. Sem eles a auditoria não pega a classe
de defeito mais comum em review humana: a descrição diz uma coisa e o código faz
outra.

### C5. A triagem perdeu a categoria da mudança

O antigo classificava em correção, funcionalidade, refatoração, configuração ou
dependência. Isso devia rotear a profundidade da auditoria: atualização de
dependência não pede a mesma leitura que funcionalidade nova.

### C6. Sem confiança por achado

Um campo de confiança permitiria esconder o que o próprio modelo acha fraco, e
daria ao reconciliador mais um eixo para medir.

### C7. Sem status de CI

A versão Python lia os checks do pull request antes de revisar. Review de
código com CI vermelho gasta modelo apontando o que o CI já apontou.

### C8. Sem cache de prompt

O runtime nativo não marca nada para cache. O prompt de sistema e as skills são
estáveis, o diff é o que varia; com provedor que suporta cache, a parte estável
sai quase de graça a partir da segunda execução.

### C9. Prompt sem acento

O modelo lê "correcao" e "nao". Não quebra nada, mas prompt é texto de produto.

## D. O que a versão Python tinha e não veio

### D1. Gatilho de review pelo Slack

O watcher antigo começava lendo o canal onde o time pede review, extraía o link
do pull request da mensagem e revisava. O Locum varre o GitHub. São modelos
diferentes: o antigo revisava o que alguém pediu para revisar; o atual revisa
tudo que se mexeu.

A fonte de menções do Slack do M8 existe, mas alimenta o digest, não o review.

### D2. Reação no Slack

O antigo reagia na mensagem ao começar e trocava a reação ao terminar, conforme
o resultado. Era o sinal visível para o time de que o pull request estava sendo
olhado.

### D3. Status de CI e preview de deploy

O `deploy_inspector` lia os checks do pull request e detectava link de preview
nos comentários. O passo de contexto de deploy do Locum vai pelo MCP do ArgoCD e
nunca rodou, porque o servidor não está cadastrado.

### D4. Otimizador de prompt e amostras de estilo

O antigo reescrevia o prompt de cada agent com um meta-prompt, a partir de
instruções de estilo da pessoa, de amostras de mensagens dela no Slack e no
GitHub, e das reviews recentes, gravando versão nova.

O Locum tem o reconciliador, que mede, mas nada que feche o ciclo e melhore o
prompt a partir da medição.

### D5. A metade do Task Sync que faltou

O M7 trouxe criação de tarefa e filtro de autoria. Faltou:

- detectar tarefa já vinculada no título ou na descrição do pull request, pelo
  padrão de chave do tracker
- comentar e sincronizar tarefa existente, em vez de só criar
- escolher tracker por repositório
- a tela de reconciliação: meus pull requests sem tarefa, os do time sem tarefa,
  e os vinculados

### D6. Iniciativas

Cadastro de iniciativa com categoria, prioridade e estado.

### D7. Auto fixer

Pegava os apontamentos críticos, escrevia a correção, rodava teste e lint, e
fazia commit assinado numa branch. Continua deliberadamente fora, pelo motivo
registrado: é o único que escreve código, e vale medir a qualidade dos achados
antes.

### D8. Rodar agora

A tela antiga tinha botão para disparar o watcher na hora. Hoje só por linha de
comando ou pelo servidor MCP.

### D9. Sessões do OpenCode

Leitor de sessões para visualização. Dispensável.

## E. Promessas do próprio desenho que ficaram em aberto

### E1. Não dá para criar nem editar agent pela interface

A tela de agents é somente leitura. Agent só nasce e muda pelo servidor MCP ou
pela linha de comando. "Configurar o agent de PR review" era o pedido original.

### E2. Corpus de convenção

A decisão 10 do ADR 0001 prevê que correção humana recorrente vire proposta de
regra na fila e, aceita, componha uma skill. O reconciliador grava os sinais;
nada os transforma em regra.

### E3. Destravar o modo automático por medição

Prometido no desenho da fila, com a tela mostrando precisão por categoria antes
de oferecer o modo. Não existe.

### E4. Exportar agents para pasta versionada

A decisão 4 do ADR 0001 prevê espelhar os agents numa pasta que seja repositório
git. Não existe.

## F. Engenharia

### F1. Nenhum teste unitário

Existe só o teste de fumaça. A lógica que mais merece teste não tem nenhum:
ordenação topológica, resolução de fallback com ciclo, cursor e deduplicação,
rebaixamento de modo de ação, casamento do reconciliador, fecho de dependentes
na reexecução. O defeito A1 teria sido pego por um teste de cinco linhas.

### F2. O processo principal virou um monólito

`electron/main.ts` passou de quatro mil linhas, quase tudo exame de fumaça.
Verificação que mora dentro do processo que ela verifica fica cara de manter e
atrapalha ler o processo de verdade.

### F3. Comentário sem acento

Setenta e seis arquivos. Decidido traduzir para inglês antes de abrir o código,
na tarefa P.2, então a correção fica para lá.

## Ordem sugerida

A primeira rodada é o que está errado hoje e custa dinheiro ou confiança:

1. A1, o run que não termina
2. A2, o orçamento que não protege
3. A3, o limite de diff
4. B1, isolar o Claude Code
5. A4 e A5
6. F1, testes para o núcleo, começando pelo que A1 revelou

A segunda é o que faz o review valer a leitura: C1 a C7 juntos, porque mexem no
mesmo prompt, e B3, porque a varredura atual não aguenta uma organização grande.

A terceira é o que falta de produto: E1, editar agent pela interface, antes de
qualquer feature nova da seção D, porque sem ele cada feature nova exige linha de
comando para ser usada.
