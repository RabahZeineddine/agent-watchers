import { mcpService, type McpService } from "./mcp-service.js";
import { providerService, type ProviderService } from "./provider-service.js";
import { secretService, type SecretService } from "./secret-service.js";

/** Quem aponta para uma credencial: um provider ou um servidor MCP. */
export interface CredentialUse {
  kind: "provider" | "mcp";
  name: string;
}

/**
 * Uma referencia de credencial como ela pode ser mostrada.
 *
 * O valor nao cabe neste tipo, e isso e de proposito: quem quiser exibir uma
 * credencial na tela ou num log so alcanca daqui o endereco e se existe algo
 * guardado nele. O segredo em si so sai pelo `SecretService.get`, que e o
 * caminho de quem vai conectar, nao o de quem vai mostrar.
 */
export interface CredentialRef {
  ref: string;
  /** Existe texto cifrado guardado. Vale mesmo sem keychain neste processo. */
  stored: boolean;
  users: CredentialUse[];
}

export interface CredentialOverview {
  /** Este processo alcanca o keychain, isto e, da para gravar e ler valor. */
  available: boolean;
  refs: CredentialRef[];
}

/**
 * O cruzamento entre o que esta guardado no cofre e quem aponta para la.
 *
 * Mora num servico porque a linha de comando, a interface e quem vier depois
 * fazem a mesma pergunta, e ela tem duas respostas erradas faceis: listar so o
 * que esta guardado esconde o cadastro que aponta para credencial inexistente,
 * e listar so o cadastro esconde o segredo que sobrou de um cadastro apagado.
 * As duas pontas entram juntas aqui.
 */
export class CredentialService {
  constructor(
    private readonly secrets: SecretService = secretService,
    private readonly providers: ProviderService = providerService,
    private readonly mcp: McpService = mcpService,
  ) {}

  async overview(): Promise<CredentialOverview> {
    const usos = new Map<string, CredentialUse[]>();
    const anotar = (ref: string, uso: CredentialUse): void => {
      usos.set(ref, [...(usos.get(ref) ?? []), uso]);
    };

    for (const [name, ref] of Object.entries(await this.providers.credentialRefs())) {
      anotar(ref, { kind: "provider", name });
    }
    for (const entry of await this.mcp.list()) {
      if (entry.credentialRef) anotar(entry.credentialRef, { kind: "mcp", name: entry.config.name });
    }

    // A uniao das duas pontas: o que o cofre tem e o que o cadastro pede. Ref
    // pedida e nao guardada aparece com `stored` falso em vez de sumir, porque
    // e exatamente esse o caso que faz um run falhar la na frente.
    const todas = new Set([...this.secrets.list(), ...usos.keys()]);

    return {
      available: this.secrets.available,
      refs: [...todas].sort().map((ref) => ({
        ref,
        stored: this.secrets.has(ref),
        users: usos.get(ref) ?? [],
      })),
    };
  }
}

export const credentialService = new CredentialService();
