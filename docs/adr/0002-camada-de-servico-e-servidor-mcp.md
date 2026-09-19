# ADR 0002: Camada de serviço e servidor MCP próprio

Data: 2026-09-19
Status: aceito
Complementa: ADR 0001

## Contexto

A lógica de cadastro vive hoje dentro de `src/cli.ts`. Três consumidores
diferentes vão precisar dela: a linha de comando, a interface do aplicativo, e
um servidor MCP que exponha o próprio produto a agents externos.

O pedido que motiva este registro é que a ferramenta nasça com servidor MCP, de
modo que um assistente possa configurá-la e operá-la de fora. Isso não é um
extra: enquanto a interface não existe, o servidor MCP é o que torna o produto
utilizável.

## Decisões

### 1. Camada de serviço antes de qualquer novo consumidor

Toda operação de cadastro e consulta passa a viver em serviços
(`AgentService`, `McpService`, `ProviderService`, `RunService`,
`ApprovalService`). Linha de comando, servidor MCP e interface são casca fina
sobre eles.

Sem isso, cada regra seria escrita três vezes e divergiria na terceira.

### 2. A ferramenta é cliente e servidor MCP ao mesmo tempo

Como **cliente**, ela consome GitHub, ArgoCD, Sonar e o que mais for cadastrado,
para dar ferramentas aos passos dos seus agents.

Como **servidor**, ela se expõe a agents externos por transporte stdio, lendo o
mesmo banco SQLite. O modo WAL permite leitura e escrita concorrentes com o
aplicativo aberto.

Os dois papéis são nomeados explicitamente no código e na documentação, porque
confundi-los gera desenho errado.

### 3. O servidor MCP expõe leitura, configuração e execução

Leitura: listar e detalhar agents, execuções, passos, achados, métricas,
servidores MCP cadastrados, provedores e o perfil da máquina.

Configuração: gravar versão de agent, cadastrar e testar servidor MCP, listar as
ferramentas de um servidor com contagem de tokens, definir tabela de fallback,
orçamento e gatilho.

Execução: disparar um agent contra um pull request ou contra evento sintético, e
reexecutar um passo isolado.

### 4. O servidor MCP não expõe aprovação nem publicação

`approve`, `reject` e qualquer ação que publique ficam fora, sem exceção.

O motivo é a invariante central do produto: se um agent pode aprovar, o portão
deixa de existir, porque passa a ser um agent liberando a saída de outro. A
garantia de que nada sai no nome do usuário viraria decoração. Aprovar continua
sendo ato humano, pela bandeja, pela interface ou pela linha de comando.

Gravar agent é diferente e fica permitido: toda gravação cria versão nova e
imutável, nenhuma versão entra em execução agendada sem o gatilho ser habilitado,
e o histórico permite desfazer. Editar é reversível e auditável; publicar no nome
de outra pessoa não é.

### 5. O servidor MCP antecede a interface na ordem de construção

A ordem passa a ser: camada de serviço, servidor MCP, casca Electron, interface,
empacotamento.

Com o servidor MCP pronto, a configuração completa do produto pode ser feita por
um assistente externo enquanto a interface está sendo construída. Isso transforma
a interface em conforto, não em pré-requisito, e reduz o risco de o projeto
parar antes de ser útil.

## Consequências

O cadastro de servidores MCP sai da lista fixa em `src/cli.ts` e passa para o
banco, atendido pelo `McpService`. Isso destrava o passo de contexto de deploy,
hoje pulado por ausência do ArgoCD.

O empacotamento ganha duas dependências de plataforma que precisam ser tratadas
no marco correspondente: módulo nativo recompilado para o runtime do Electron, e
assinatura com notarização para que a atualização automática funcione. Sem conta
de desenvolvedor Apple, o aplicativo ainda roda em uso pessoal, com aviso na
primeira abertura.

## Alternativas consideradas

Expor a aprovação pelo servidor MCP com um destravamento explícito por
configuração. Descartado: a exceção existiria justamente para o caso em que ela
é mais perigosa, e a invariante vale mais que a conveniência.

Construir a interface antes do servidor MCP. Descartado porque adia a
usabilidade do produto em várias semanas sem necessidade.
