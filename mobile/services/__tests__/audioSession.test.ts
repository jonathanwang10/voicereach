// H2-5.2: one owner for the iOS audio session. Recording has priority over the
// Assistant's conversation and over plain playback.
import * as fs from 'fs';
import * as path from 'path';
import { setAudioModeAsync } from 'expo-audio';
import { AudioManager } from 'react-native-audio-api';
import {
  acquireConversation,
  acquirePlayback,
  acquireRecording,
  AudioSessionState,
  isRecordingActive,
  onChange,
  __resetAudioSessionForTests,
} from '../audioSession';

const modeCalls = () => (setAudioModeAsync as jest.Mock).mock.calls.map(c => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  __resetAudioSessionForTests();
});

it('acquireRecording sets record mode and its release restores playback mode', async () => {
  const release = await acquireRecording('record-tab');
  expect(setAudioModeAsync).toHaveBeenLastCalledWith(expect.objectContaining({ allowsRecording: true, playsInSilentMode: true }));
  await release();
  expect(setAudioModeAsync).toHaveBeenLastCalledWith(expect.objectContaining({ allowsRecording: false, playsInSilentMode: true }));
  expect(AudioManager.setAudioSessionOptions).toHaveBeenLastCalledWith(expect.objectContaining({ iosCategory: 'playback' }));
});

it('isRecordingActive is true from acquire until release', async () => {
  expect(isRecordingActive()).toBe(false);
  const release = await acquireRecording('record-tab');
  expect(isRecordingActive()).toBe(true);
  await release();
  expect(isRecordingActive()).toBe(false);
});

it('acquirePlayback returns null while a recording holds the session', async () => {
  const release = await acquireRecording('record-tab');
  (setAudioModeAsync as jest.Mock).mockClear();
  (AudioManager.setAudioSessionOptions as jest.Mock).mockClear();
  expect(await acquirePlayback('assistant')).toBeNull();
  expect(setAudioModeAsync).not.toHaveBeenCalled();
  expect(AudioManager.setAudioSessionOptions).not.toHaveBeenCalled();
  await release();
});

it('acquirePlayback during a conversation changes no mode', async () => {
  const end = await acquireConversation('assistant');
  (setAudioModeAsync as jest.Mock).mockClear();
  (AudioManager.setAudioSessionOptions as jest.Mock).mockClear();
  const release = await acquirePlayback('assistant-reply');
  expect(release).not.toBeNull();
  await release!();
  expect(setAudioModeAsync).not.toHaveBeenCalled();
  expect(AudioManager.setAudioSessionOptions).not.toHaveBeenCalled();
  await end!();
});

it('acquireConversation sets play-and-record on the speaker', async () => {
  await acquireConversation('assistant');
  expect(AudioManager.setAudioSessionOptions).toHaveBeenLastCalledWith(expect.objectContaining({
    iosCategory: 'playAndRecord', iosMode: 'voiceChat', iosOptions: expect.arrayContaining(['defaultToSpeaker']) }));
  expect(AudioManager.setAudioSessionActivity).toHaveBeenCalledWith(true);
});

it('acquireConversation returns null while a recording holds the session', async () => {
  const release = await acquireRecording('record-tab');
  (AudioManager.setAudioSessionOptions as jest.Mock).mockClear();
  expect(await acquireConversation('assistant')).toBeNull();
  expect(AudioManager.setAudioSessionOptions).not.toHaveBeenCalled();
  await release();
});

it('a recording acquired during a conversation wins', async () => {
  const states: AudioSessionState[] = [];
  onChange(s => states.push(s));
  const endConversation = await acquireConversation('assistant');
  const endRecording = await acquireRecording('record-tab');
  expect(states.at(-1)).toEqual({ recordingOwner: 'record-tab', conversationOwner: null });
  (setAudioModeAsync as jest.Mock).mockClear();
  await endConversation!();                       // late release from the preempted owner
  expect(setAudioModeAsync).not.toHaveBeenCalled(); // record mode untouched
  await endRecording();
});

it('a release called twice changes the mode once', async () => {
  const release = await acquireRecording('record-tab');
  (setAudioModeAsync as jest.Mock).mockClear();
  await release();
  await release();
  expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
});

it('mode changes run in the order they were asked for', async () => {
  let finishFirst: () => void = () => {};
  (setAudioModeAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { finishFirst = r; }));
  const acquiring = acquireRecording('record-tab');
  const releasing = acquiring.then(release => release());
  await Promise.resolve();
  finishFirst();
  await releasing;
  const calls = modeCalls();
  expect(calls[0].allowsRecording).toBe(true);
  expect(calls[1].allowsRecording).toBe(false);
});

it('a failed mode change does not break the chain', async () => {
  (setAudioModeAsync as jest.Mock).mockRejectedValueOnce(new Error('session busy'));
  const release = await acquireRecording('record-tab');
  await release();
  expect(modeCalls().at(-1).allowsRecording).toBe(false);
});

it('onChange returns an unsubscribe', async () => {
  const listener = jest.fn();
  const unsubscribe = onChange(listener);
  const release = await acquireRecording('record-tab');
  unsubscribe();
  await release();
  expect(listener).toHaveBeenCalledTimes(1);
});

// enabled in Task 8 once expo-av's callers are gone
it.skip('no other file changes the audio session', () => {
  const root = path.resolve(__dirname, '../..');
  const skip = new Set(['node_modules', 'ios', 'android', '__tests__', 'test', '.expo']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(entry.name) && full !== path.join(root, 'services', 'audioSession.ts')
        && /setAudioModeAsync|setAudioSessionOptions|setAudioSessionActivity/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
