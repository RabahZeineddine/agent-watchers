import { settingsService, type SettingsService } from "./settings-service.js";

/** Chave única da preferência, para os dois processos lerem o mesmo lugar. */
export const AUTO_UPDATE_KEY = "updates.auto_check";

/** O que está guardado e o que isso significa na prática. */
export interface UpdatePreference {
  /** `null` quando ninguém decidiu ainda. */
  preference: boolean | null;
  /** O que vale agora. Sem decisão, vale ligado. */
  enabled: boolean;
}

/**
 * Atualização automática, ligada até alguém desligar.
 *
 * Nasceu desligada porque o caminho era o Squirrel do macOS, que recusa pacote
 * sem assinatura da Apple. A troca agora é do próprio Locum, em
 * `src/update/release.ts`, e funciona sem certificado; o motivo do padrão
 * desligado deixou de existir.
 *
 * Como no `StartupService`, `null` é diferente de `false`: um diz que ninguém
 * decidiu, o outro que alguém decidiu que não. Foi essa distinção que deixou o
 * padrão mudar sem passar por cima de quem já tinha desligado.
 */
export class UpdateService {
  constructor(private readonly settings: SettingsService = settingsService) {}

  /** `null` quando ninguém decidiu ainda. */
  async getPreference(): Promise<boolean | null> {
    return (await this.settings.getBoolean(AUTO_UPDATE_KEY)) ?? null;
  }

  /** O que a casca Electron consulta para decidir se arma o verificador. */
  async isEnabled(): Promise<boolean> {
    return (await this.getPreference()) !== false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.settings.setBoolean(AUTO_UPDATE_KEY, enabled);
  }

  /** Devolve a preferência ao estado de nunca decidida. */
  async clearPreference(): Promise<boolean> {
    return this.settings.remove(AUTO_UPDATE_KEY);
  }

  async state(): Promise<UpdatePreference> {
    const preference = await this.getPreference();
    return { preference, enabled: preference !== false };
  }
}

export const updateService = new UpdateService();
