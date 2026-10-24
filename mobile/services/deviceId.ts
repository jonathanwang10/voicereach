// A random id per install (H2-6.15), sent as X-Device-Id so rate limits and the audit
// log can tell phones on the shared demo account apart. Not derived from the hardware.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { newRequestId } from '../utils/requestId';

export const DEVICE_ID_KEY = 'voicereach.device_id';

let pending: Promise<string> | null = null;

const load = async (): Promise<string> => {
  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    const id = newRequestId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // Storage unavailable: an id for this run only
    return newRequestId();
  }
};

// Memoised, so concurrent first calls agree
export const getDeviceId = (): Promise<string> => pending ?? (pending = load());

export const __resetDeviceIdForTests = (): void => {
  pending = null;
};
