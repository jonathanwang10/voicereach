// H2-6.12: the Supabase session is AES-256 encrypted in AsyncStorage; its key lives in the
// iOS Keychain (this device only). An old plaintext session is migrated in place.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { LargeSecureStore } from '../secureSessionStorage';

const KEY = 'sb-abc-auth-token';
const SESSION = JSON.stringify({ access_token: 'secret-token', refresh_token: 'r' });

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as any).__store.clear();
});

it('AsyncStorage never holds the plaintext session', async () => {
  await new LargeSecureStore().setItem(KEY, SESSION);
  const raw = await AsyncStorage.getItem(KEY);
  expect(raw).toMatch(/^[0-9a-f]+$/);
  expect(raw).not.toContain('secret-token');
  expect(await SecureStore.getItemAsync(KEY)).toMatch(/^[0-9a-f]{64}$/);
});

it('round-trips the session', async () => {
  const store = new LargeSecureStore();
  await store.setItem(KEY, SESSION);
  expect(await store.getItem(KEY)).toBe(SESSION);
});

it('uses a fresh key for every write', async () => {
  const store = new LargeSecureStore();
  await store.setItem(KEY, SESSION);
  const first = await SecureStore.getItemAsync(KEY);
  await store.setItem(KEY, SESSION);
  expect(await SecureStore.getItemAsync(KEY)).not.toBe(first);
  expect(await store.getItem(KEY)).toBe(SESSION);
});

it('keeps the key on this device only', async () => {
  await new LargeSecureStore().setItem(KEY, SESSION);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY, expect.any(String),
    { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
});

it('nothing stored reads as null', async () => {
  expect(await new LargeSecureStore().getItem(KEY)).toBeNull();
});

it('migrates a plaintext session written by the old storage', async () => {
  await AsyncStorage.setItem(KEY, SESSION);
  expect(await new LargeSecureStore().getItem(KEY)).toBe(SESSION);
  expect(await AsyncStorage.getItem(KEY)).toMatch(/^[0-9a-f]+$/);
  expect(await new LargeSecureStore().getItem(KEY)).toBe(SESSION);
});

it('drops ciphertext whose key is gone instead of failing', async () => {
  await AsyncStorage.setItem(KEY, 'abcdef0123');
  expect(await new LargeSecureStore().getItem(KEY)).toBeNull();
  expect(await AsyncStorage.getItem(KEY)).toBeNull();
});

it('removeItem clears both stores', async () => {
  const store = new LargeSecureStore();
  await store.setItem(KEY, SESSION);
  await store.removeItem(KEY);
  expect(await AsyncStorage.getItem(KEY)).toBeNull();
  expect(await SecureStore.getItemAsync(KEY)).toBeNull();
});
