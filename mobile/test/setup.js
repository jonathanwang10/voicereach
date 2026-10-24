// AsyncStorage is a native module; use the official mock so suites that pull in
// services/supabase.ts can run under Jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

process.env.EXPO_PUBLIC_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'http://localhost:54321';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key';

// H2-6.12: the session's key store. An in-memory Keychain, exposed as __store.
jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __store: store,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItemAsync: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async key => { store.delete(key); }),
  };
});
// aes-js needs crypto.getRandomValues: the polyfill is native, Node's webcrypto stands in.
jest.mock('react-native-get-random-values', () => ({}));
if (!globalThis.crypto?.getRandomValues) {
  Object.defineProperty(globalThis, 'crypto', { value: require('crypto').webcrypto, configurable: true });
}

// TanStack Query batches its notifications on setTimeout(0), which act() doesn't wait
// for; a microtask lands inside act(async () => ...)
require('@tanstack/react-query').notifyManager.setScheduler(fn => Promise.resolve().then(fn));

// H2-6.6: NetInfo's own mock (isConnected true, addEventListener a jest.fn)
jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock.js'));

// expo-crypto is a native module; Node's crypto gives the same v4 UUIDs.
jest.mock('expo-crypto', () => ({ randomUUID: () => require('crypto').randomUUID() }));

// H2-5.1: the two native audio libraries. react-native-audio-api ships its own mock;
// expo-audio gets a minimal one. Suites that need richer fakes override with jest.mock.
// The shipped mock has no audio-session methods: they are added as jest.fns so tests can
// assert on them.
jest.mock('react-native-audio-api', () => {
  const mock = jest.requireActual('react-native-audio-api/mock');
  const AudioManager = {
    ...Object.fromEntries(Object.getOwnPropertyNames(mock.AudioManager)
      .filter(k => typeof mock.AudioManager[k] === 'function')
      .map(k => [k, mock.AudioManager[k]])),
    setAudioSessionOptions: jest.fn(),
    setAudioSessionActivity: jest.fn(async () => true),
    requestRecordingPermissions: jest.fn(async () => 'Granted'),
    observeAudioInterruptions: jest.fn(),
    addSystemEventListener: jest.fn(() => ({ remove: jest.fn() })),
  };
  return { ...mock, AudioManager };
});
jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn(async () => undefined),
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
  RecordingPresets: { HIGH_QUALITY: {}, LOW_QUALITY: {} },
  IOSOutputFormat: { MPEG4AAC: 'aac ' },
  AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
}));
