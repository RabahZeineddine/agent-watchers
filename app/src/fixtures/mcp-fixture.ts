import { join } from "node:path";
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
 * Os caminhos entram absolutos porque o cadastro nao tem campo de diretorio de
 * trabalho: quem sobe o processo usa o `cwd` de quem chamou, que e a raiz do
 * repositorio para um cliente e `app/` para outro. E chama `node` com o `tsx`
 * pelo caminho, e nao `npx`, pelo mesmo motivo do `.mcp.json`.
 */
export const FIXTURE_SERVER = "locum-fixture";

export async function ensureFixtureServer(appDir: string): Promise<McpServerEntry> {
  // O cadastro e por nome, entao registrar de novo sobrescreve em vez de
  // acumular linha a cada subida do smoke.
  return mcpService.register({
    name: FIXTURE_SERVER,
    transport: "stdio",
    command: [
      "node",
      join(appDir, "node_modules", "tsx", "dist", "cli.mjs"),
      join(appDir, "src", "fixtures", "mcp-fixture-server.ts"),
    ],
    scope: "read",
  });
}
