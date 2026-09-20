import { safeStorage } from "electron";
import { secretService, type SecretBackend } from "../src/services/secret-service.js";

/**
 * Cofre do sistema, via `safeStorage`.
 *
 * No macOS a chave de cifra fica no keychain, sob o nome do app, e o que sai de
 * `encryptString` e texto cifrado que so este usuario nesta maquina reabre. O
 * Electron nao expoe a API de item do keychain, entao guardar o valor inteiro
 * la dentro nao e opcao: o par chave no keychain mais texto cifrado no disco e
 * o caminho que ele oferece.
 */
export const safeStorageBackend: SecretBackend = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (blob) => safeStorage.decryptString(blob),
};

/**
 * Liga o cofre ao servico. Depois de `app.whenReady`, porque antes disso o
 * `safeStorage` ainda nao sabe responder se o keychain esta disponivel.
 */
export function installSecretBackend(): boolean {
  secretService.useBackend(safeStorageBackend);
  return secretService.available;
}
