// AsyncStorage is a native module; use the official mock so suites that pull in
// services/supabase.ts can run under Jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

process.env.EXPO_PUBLIC_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'http://localhost:54321';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key';

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
