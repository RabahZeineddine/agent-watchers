import { mcpService, type McpServerEntry } from "../services/mcp-service.js";

/**
 * Cadastro do servidor de brinquedo, para a tela de configuracao ter o que
 * testar.
 *
 * Banco novo nao tem servidor MCP nenhum, e uma tela que lista zero servidores
 * passa numa verificacao sem provar nada: o botao de testar conexao nem
 * apareceria. O alvo e o `mcp-fixture-server.ts`, que nao depende de rede nem
 * de nada instalado na maquina, entao subi-lo custa alguns segundos e mais
 * nada.
 *
 * O comando vem de quem chama porque so ele sabe com que runtime o processo
 * sobe: rodando do repositorio e um Node qualquer, e dentro do `.app` e o
 * proprio binario do Electron em modo Node. O cadastro nao tem campo de
 * diretorio de trabalho, entao o caminho entra absoluto.
 */
export const FIXTURE_SERVER = "locum-fixture";

export interface FixtureLauncher {
  command: string[];
  env?: Record<string, string>;
}

export async function ensureFixtureServer(launcher: FixtureLauncher): Promise<McpServerEntry> {
  // O cadastro e por nome, entao registrar de novo sobrescreve em vez de
  // acumular linha a cada subida do smoke.
  return mcpService.register({
    name: FIXTURE_SERVER,
    transport: "stdio",
    command: launcher.command,
    env: launcher.env,
    scope: "read",
  });
}
