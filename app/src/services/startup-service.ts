import { settingsService, type SettingsService } from "./settings-service.js";

/** Chave unica da preferencia, para os dois processos lerem o mesmo lugar. */
export const OPEN_AT_LOGIN_KEY = "startup.open_at_login";

/**
 * Subir junto com o login e decisao de quem instala, nao do instalador.
 *
 * Por isso a preferencia tem tres estados e nao dois: `null` quer dizer que
 * ninguem decidiu ainda, e a casca Electron respeita isso nao mexendo no
 * sistema. Ligar sozinho na primeira execucao seria escrever uma decisao que
 * o dono da maquina nunca tomou.
 */
export class StartupService {
  constructor(private readonly settings: SettingsService = settingsService) {}

  /** `null` quando ninguem decidiu ainda. */
  async getPreference(): Promise<boolean | null> {
    return (await this.settings.getBoolean(OPEN_AT_LOGIN_KEY)) ?? null;
  }

  async setPreference(enabled: boolean): Promise<void> {
    await this.settings.setBoolean(OPEN_AT_LOGIN_KEY, enabled);
  }

  /** Devolve a preferencia ao estado de nunca decidida. */
  async clearPreference(): Promise<boolean> {
    return this.settings.remove(OPEN_AT_LOGIN_KEY);
  }
}

export const startupService = new StartupService();
