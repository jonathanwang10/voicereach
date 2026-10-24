// The Supabase session at rest (H2-6.12), Supabase's LargeSecureStore pattern: the
// session is AES-256-CTR encrypted in AsyncStorage (it is too large for the Keychain),
// and its key, fresh for every write, is in the iOS Keychain for this device only (not
// in iCloud Keychain or backups).
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as aesjs from 'aes-js';

const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export class LargeSecureStore {
  private async encrypt(key: string, value: string): Promise<string> {
    const encryptionKey = globalThis.crypto.getRandomValues(new Uint8Array(256 / 8));
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey), KEYCHAIN);
    return aesjs.utils.hex.fromBytes(encrypted);
  }

  private decrypt(keyHex: string, value: string): string {
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(keyHex), new aesjs.Counter(1));
    return aesjs.utils.utf8.fromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
  }

  async getItem(key: string): Promise<string | null> {
    const stored = await AsyncStorage.getItem(key);
    if (!stored) return null;
    // The plaintext JSON an older build wrote (storage: AsyncStorage): encrypt it in place
    if (stored.startsWith('{')) {
      await this.setItem(key, stored);
      return stored;
    }
    const keyHex = await SecureStore.getItemAsync(key);
    if (!keyHex) {
      // Ciphertext whose key is gone (e.g. a restored backup): drop it, so the normal
      // sign-in runs instead of a failed one
      await AsyncStorage.removeItem(key);
      return null;
    }
    return this.decrypt(keyHex, stored);
  }

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, await this.encrypt(key, value));
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key);
  }
}
