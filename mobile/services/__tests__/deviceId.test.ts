// H2-6.15: a random id per install, sent as X-Device-Id so phones on the shared account differ.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEVICE_ID_KEY, getDeviceId, __resetDeviceIdForTests } from '../deviceId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(async () => {
  jest.restoreAllMocks();
  __resetDeviceIdForTests();
  await AsyncStorage.clear();
});

it('creates one v4 UUID, stores it, and returns the same id afterwards', async () => {
  const id = await getDeviceId();
  expect(id).toMatch(UUID_V4);
  expect(DEVICE_ID_KEY).toBe('voicereach.device_id');
  expect(await AsyncStorage.getItem('voicereach.device_id')).toBe(id);
  __resetDeviceIdForTests();
  expect(await getDeviceId()).toBe(id);   // read back from storage, not regenerated
});

it('concurrent first calls agree', async () => {
  const [a, b] = await Promise.all([getDeviceId(), getDeviceId()]);
  expect(a).toBe(b);
});

it('still returns an id when storage fails', async () => {
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
  expect(await getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
});
