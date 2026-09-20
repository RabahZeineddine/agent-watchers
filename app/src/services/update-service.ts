import { settingsService, type SettingsService } from "./settings-service.js";

/** Chave única da preferência, para os dois processos lerem o mesmo lugar. */
export const AUTO_UPDATE_KEY = "updates.auto_check";

/** O que está guardado e o que isso significa na prática. */
export interface UpdatePreference {
  /** `null` quando ninguém decidiu ainda. */
  preference: boolean | null;
  /** O que vale agora. Sem decisão, vale desligado. */
  enabled: boolean;
}

/**
 * Atualização automática, desligada até alguém ligar.
 *
 * O padrão desligado não é cautela genérica: sem certificado da Apple o pacote
 * não é assinado, e atualização não assinada o macOS recusa na hora de aplicar.
 * Ligar o verificador nesse estado só gastaria rede para descobrir uma versão
 * que nunca vai instalar.
 *
 * Como no `StartupService`, `null` é diferente de `false`: um diz que ninguém
 * decidiu, o outro que alguém decidiu que não. Os dois resultam em desligado,
 * mas só o segundo sobrevive a um dia em que o padrão mudar.
 */
export class UpdateService {
  constructor(private readonly settings: SettingsService = settingsService) {}

  /** `null` quando ninguém decidiu ainda. */
  async getPreference(): Promise<boolean | null> {
    return (await this.settings.getBoolean(AUTO_UPDATE_KEY)) ?? null;
  }

  /** O que a casca Electron consulta para decidir se arma o verificador. */
  async isEnabled(): Promise<boolean> {
    return (await this.getPreference()) === true;
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
    return { preference, enabled: preference === true };
  }
}

export const updateService = new UpdateService();
