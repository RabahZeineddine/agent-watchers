# Empacotamento, instalação e assinatura

Como sai o `.dmg`, o que acontece ao abri-lo sem assinatura, o que muda com uma
conta de desenvolvedor Apple, e por que a atualização automática depende dela.

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
Este projeto não gera certificado, não configura notarização e não publica em
servidor de atualização. O que mudaria, se alguém decidisse assinar:

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

**A atualização automática** passa a ser possível, que é o assunto da próxima
seção.

## Por que a atualização automática depende disso

O `electron-updater` está instalado e ligado atrás de um interruptor, desligado
por padrão. O padrão desligado não é preguiça nem cautela genérica.

O macOS recusa instalar uma atualização que não esteja assinada. O updater até
baixaria o pacote novo, mas a troca falharia na hora de aplicar. Ligar a
verificação hoje só gastaria rede para descobrir uma versão que nunca entra.

Desligado, o `electron-updater` sequer é importado. Um módulo carregado "só
para consultar" deixa temporizador de pé, e é assim que um verificador acaba
batendo num servidor que o dono da máquina nunca autorizou. O `--smoke` prova
isso contando o que sai pelo `http`, pelo `https` e pelo `net` do Electron: ler
o código e concluir que ele decide não chamar não diz nada sobre o que um
temporizador faz três segundos depois.

O interruptor mora em `settings` e se lê pela linha de comando:

```bash
npm run dev updates       # mostra o estado
npm run dev updates:on    # liga a verificação na subida do aplicativo
npm run dev updates:off   # desliga
```

Ligar hoje não quebra nada: a seção `publish` do `electron-builder.yml` diz de
onde a atualização viria, mas quem decide consultá-la é a preferência. E o
`app-update.yml`, que o electron-builder grava dentro do pacote, só nasce
quando o alvo é `dmg` ou `zip`: um pacote feito por `dist:dir` fica sem feed, e
o verificador ligado ali dentro responde que não há o que verificar em vez de
armar.

Com conta de desenvolvedor, o caminho completo seria: assinar, notarizar,
publicar o release, e só então ligar o interruptor. Nessa ordem. Ligar antes
entrega ao usuário um download que o sistema dele vai recusar.
