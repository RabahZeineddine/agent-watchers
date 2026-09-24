# Empacotamento, instalação e assinatura

Como sai o `.dmg`, o que acontece ao abri-lo sem assinatura, o que muda com uma
conta de desenvolvedor Apple, e como o Locum se atualiza sem ela.

A configuração vive em `app/electron-builder.yml`, e cada decisão dela está
comentada no próprio arquivo. Aqui está o procedimento e o que ele significa
para quem instala.

## Gerar o pacote

Tudo roda a partir de `app/`.

```bash
cd app
npm install
npm run build        # processo principal por esbuild, janela por Vite
npm run dist:dir     # .app sem instalador, em release/mac-<arch>/Locum.app
npm run smoke:dist   # sobe o binário de dentro do .app com --smoke, sai 0
npm run dist         # .dmg e .zip, em release/
```

O `dist:dir` é o passo de trabalho: ele produz o `Locum.app` em segundos e é
contra ele que a fumaça roda. O `dist` só acrescenta o empacotamento em `.dmg`
e `.zip`, que demora e não muda nada do que está dentro do aplicativo.

Nenhum dos dois publica: ambos passam `--publish never` de propósito. Subir
arquivo para um servidor de releases é decisão de quem é dono do repositório, e
não pode acontecer por efeito colateral de um comando de build.

O que sai fica em `app/release/`, que não é versionado.

### Verificar antes de empacotar

`npm run verify` roda a bateria de desenvolvimento: tipos, guarda de i18n,
build e fumaça. Ela não prova nada sobre o pacote. Caminho de recurso, asar e
módulo nativo só quebram depois de empacotar, e quebram calados: o aplicativo
instalado abre e fecha sem dizer por quê. Por isso existe o `smoke:dist`, que
executa `Locum.app/Contents/MacOS/Locum --smoke` com a mesma bateria de
verificações do desenvolvimento, só que de dentro do pacote.

### Empacotar para a outra arquitetura

O binário nativo do `better-sqlite3` carrega a arquitetura no nome, em
`app/native/`, porque um `.node` só serve para a arquitetura em que foi
compilado. Empacotar x64 numa máquina arm64 sem gerar a cópia certa produz um
aplicativo que instala e não abre.

```bash
node scripts/build-main.mjs --arch x64
npm run dist
```

Sem a cópia, a subida estoura dizendo qual arquivo faltou, o que é bem melhor
do que um aplicativo que some da tela sem explicação.

### Regerar o ícone

O ícone é versionado como `app/build/icon.svg` e como `app/build/icon.icns`. O
`.icns` entra no repositório porque o empacotamento depende dele e regerá-lo
exige macOS, com o `sips` e o `iconutil` do próprio sistema:

```bash
npm run build:icon
```

### O que entra no pacote, e o tamanho que dá

| | antes | depois |
|---|---|---|
| `Locum.app` | 420 MB | 234 MB |
| `Locum-0.1.0-arm64.dmg` | 138 MB | 100 MB |

Medido com `du -sm` no `.app` de `dist:dir` e no `.dmg` de `dist`, nas duas
versões da configuração, na mesma máquina arm64.

Os 186 MB que saíram do aplicativo vieram de dois lugares.

O maior era `node_modules`. O `electron-builder` embrulha a árvore de produção
inteira por padrão, e quase nada dela servia para alguma coisa dentro do
`.app`: React, Radix, Shiki e as fontes já tinham sido embutidos pelo Vite na
página da janela, e viajavam de novo em código-fonte; o Octokit sozinho passava
de cem megabytes. Agora o `esbuild` embute tudo o que o processo principal
importa em `dist/main.cjs`, e o pacote sai sem `node_modules`. A exceção é o
invólucro JS do `better-sqlite3`, que chega ao binário nativo por `require` de
caminho e por isso não se deixa embutir.

O resto eram as 220 traduções do Chromium que o Electron traz. A interface do
Locum existe em duas, e sistema em qualquer outro idioma já cai em inglês.

As duas pontas são uma coisa só: o `external` em `app/scripts/build-main.mjs` e
o `!node_modules/**` em `app/electron-builder.yml` só funcionam juntos. Uma
dependência nova que o processo principal importe entra no pacote pelo bundle,
sem precisar de nada; mas algo que resolva módulo por caminho em tempo de
execução precisa ser declarado nos dois lugares, e a falta só aparece no
`smoke:dist`, nunca no `smoke` de desenvolvimento, que ainda tem o
`node_modules` do repositório ao alcance.

## Abrir sem assinatura

O pacote sai sem assinatura da Apple, e é isso que quem instala encontra.

O macOS carimba todo arquivo baixado com a marca de quarentena. Ao abrir um
aplicativo assim que não esteja assinado e notarizado, o Gatekeeper recusa, com
alguma variação de *"Locum não pôde ser aberto porque a Apple não pode
verificar se ele contém software malicioso"*. Dependendo da versão do sistema, o
diálogo oferece mover o aplicativo para o Lixo e nada mais.

O contorno é da própria Apple, e é por aplicativo, uma vez só:

1. Arraste o `Locum.app` para `/Applications`.
2. Clique nele com o botão direito e escolha **Abrir**. O mesmo diálogo aparece,
   agora com a opção de abrir assim mesmo.
3. Confirme. O sistema registra a decisão, e as próximas aberturas são normais.

Se o diálogo não oferecer a opção, vá em **Ajustes do Sistema > Privacidade e
Segurança** logo depois da tentativa: há um botão de abrir assim mesmo referente
ao último aplicativo bloqueado.

Quem preferir tirar a quarentena pela linha de comando:

```bash
xattr -dr com.apple.quarantine /Applications/Locum.app
```

Vale entender o que esse comando faz antes de rodá-lo em qualquer coisa: ele
manda o sistema parar de tratar o aplicativo como baixado da internet. Aqui é
aceitável porque quem instala é quem gerou o pacote, a partir deste
repositório. Não é um hábito para aplicativo vindo de terceiro.

### O que o Gatekeeper ainda cobra

Duas coisas continuam valendo mesmo depois de abrir:

**Item de login.** O `app.setLoginItemSettings` só é aceito de aplicativo
empacotado, assinado e notarizado. Instalado sem assinatura, o Locum grava a
preferência e o sistema não a honra.

**Retorno de OAuth por `locum://`.** O protocolo é registrado pelo `Info.plist`
do aplicativo instalado, o que funciona sem assinatura. O que o sistema pode
recusar é abrir um aplicativo bloqueado a partir de um link, então convém abrir
o Locum uma vez pelo Finder antes de usar qualquer retorno de autenticação.

## Com conta de desenvolvedor Apple

A conta custa uma assinatura anual e é decisão de quem é dono do repositório.
Este projeto não gera certificado nem configura notarização. O que mudaria, se
alguém decidisse assinar:

**A assinatura** carimba o pacote com um certificado Developer ID. Hoje
`electron-builder.yml` traz `mac.identity: null`, e isso é explícito de
propósito: deixando o padrão, o electron-builder procura identidade no keychain
e falha o empacotamento por não achar nenhuma. Com conta, o campo sai e o
certificado é encontrado sozinho.

**A notarização** é o passo seguinte: o pacote assinado sobe para a Apple, que
o examina e devolve um bilhete grampeado no arquivo. É o que faz o Gatekeeper
abrir sem diálogo nenhum. Exige credencial de API da App Store Connect, que é
segredo e não entra neste repositório, nem em variável de ambiente versionada.

**O item de login** passa a funcionar, porque o sistema aceita registrar como
item de arranque um aplicativo que ele consegue verificar.

**A atualização automática** não depende disso: ela já funciona sem
assinatura, pela troca própria descrita na próxima seção. Com assinatura, a
troca continuaria valendo; o que mudaria é o macOS deixar de pedir a
confirmação da primeira abertura.

## Atualização automática

O `electron-updater` troca o aplicativo pelo Squirrel do macOS, e o Squirrel
recusa pacote sem assinatura da Apple. Por isso ele saiu. A troca agora é do
próprio Locum, em `app/src/update/release.ts`, e funciona sem certificado.

**O que o aplicativo instalado faz.** Dez segundos depois de abrir, e a cada
seis horas, ele pergunta ao GitHub pelo release mais recente de
`RabahZeineddine/locum`, sem token, porque o repositório é público.
Achando versão maior que a instalada:

1. baixa o `locum-update.json` do release, que traz o sha512 de cada pacote;
2. baixa o `.zip` da arquitetura dele, calculando o hash no caminho, e apaga o
   arquivo se o hash não bater;
3. extrai com `ditto`, que preserva os links simbólicos do framework do
   Electron, e confere que o `Info.plist` diz a versão prometida;
4. avisa por notificação e espera.

A troca só acontece **depois** que o processo sai. Um script desligado do
aplicativo espera o PID sumir, move o bundle antigo para uma cópia de
segurança, põe o novo no lugar e apaga a cópia; se o segundo passo falhar, a
cópia volta. Trocar com o aplicativo aberto é o que corrompe a janela: o
processo guarda na memória o índice do `app.asar` e passa a ler pedaço de outro
arquivo.

Em **Configuração > Atualização** ficam a versão instalada, o que está baixado,
**Conferir agora**, **Reiniciar e atualizar** e o interruptor. Nasce ligado;
quem desliga fica desligado, porque a preferência distingue "ninguém decidiu"
de "decidiu que não". Pela linha de comando:

```bash
npm run dev updates       # mostra o estado
npm run dev updates:on
npm run dev updates:off
```

Não atualiza: rodando do repositório (quem tem o código atualiza por `git
pull`), aberto de dentro do `.dmg` e aberto translocado pelo macOS, que roda
uma cópia num caminho aleatório. A tela diz qual dos três é.

O `--smoke` conta o que sai pelo `http`, pelo `https`, pelo `net` e pelo `fetch`
e prova que desligado não faz requisição nenhuma.

**Publicar uma versão** é pelo script, de uma árvore limpa no `main`
sincronizado:

```bash
cd app
npm run release              # 0.1.0 vira 0.1.1
npm run release -- minor     # ou major, ou uma versão x.y.z
npm run release -- --dry-run # tudo menos commit, push e release
```

Ele sobe a versão, roda `verify`, os testes, empacota `dmg` e `zip` para arm64,
roda a fumaça do pacote, gera o manifesto, extrai o zip do mesmo jeito que o
aplicativo faria, e só então commita, etiqueta, empurra e cria o release pelo
`gh` da conta pessoal. Só arm64 porque o binário nativo do SQLite em `native/`
é compilado para arm64.

A primeira versão com o verificador precisa ser instalada à mão: o Locum que
já estava instalado não tem o código que baixa.

