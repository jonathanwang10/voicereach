// H2-5.1: every suite gets mocks for the two native audio libraries
import { AudioContext, AudioRecorder, AudioManager } from 'react-native-audio-api';
import * as ExpoAudio from 'expo-audio';

it('react-native-audio-api is mocked for every suite', () => {
  const ctx = new AudioContext({ sampleRate: 24000 });
  expect(typeof ctx.createBufferQueueSource().enqueueBuffer).toBe('function');
  expect(typeof new AudioRecorder().onAudioReady).toBe('function');
  expect(typeof AudioManager.setAudioSessionOptions).toBe('function');
});

it('expo-audio is mocked for every suite', async () => {
  await expect(ExpoAudio.setAudioModeAsync({ allowsRecording: true })).resolves.toBeUndefined();
  expect(jest.isMockFunction(ExpoAudio.setAudioModeAsync)).toBe(true);
  expect(jest.isMockFunction(ExpoAudio.useAudioRecorder)).toBe(true);
});
