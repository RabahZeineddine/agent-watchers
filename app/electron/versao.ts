import pacote from "../package.json";

/**
 * A versão do Locum, lida do `package.json` embutido no build.
 *
 * Não pelo `app.getVersion()`: rodando do código, o Electron não acha o
 * `package.json` ao lado de `dist/main.cjs` e devolve a versão dele mesmo, e a
 * tela diria "versão 40.10.6". Empacotado os dois concordam, e o script de
 * release só grava a versão no `package.json`.
 */
export const VERSAO: string = pacote.version;
