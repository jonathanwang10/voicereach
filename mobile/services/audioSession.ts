// The one owner of the iOS audio session (H2-5.2). Every mode change in the app goes
// through here; no other file calls setAudioModeAsync or AudioManager's session methods.
//
// - record: the Record tab's M4A note (expo-audio). Recording has priority: while it is
//   held, playback and conversation get null, and a recording acquired during a
//   conversation takes the session over (the Assistant's late release changes nothing).
// - conversation: the Assistant's mic streams while a reply plays, on the loudspeaker
//   (play-and-record, voiceChat, defaultToSpeaker), set through react-native-audio-api.
// - playback: the resting mode. Releasing the last holder restores it.
// Mode changes run in order on one promise chain; a failed change is logged in dev and
// doesn't break the chain.
import { setAudioModeAsync } from 'expo-audio';
import { AudioManager } from 'react-native-audio-api';

export type AudioSessionState = { recordingOwner: string | null; conversationOwner: string | null };

let recordingOwner: string | null = null;
let conversationOwner: string | null = null;
let conversationToken = 0;   // a preempted conversation's release is stale
let playbackHolders = 0;
let chain: Promise<void> = Promise.resolve();
const listeners = new Set<(state: AudioSessionState) => void>();

const state = (): AudioSessionState => ({ recordingOwner, conversationOwner });
const notify = () => listeners.forEach(listener => listener(state()));

const enqueue = (change: () => Promise<void> | void): Promise<void> => {
  chain = chain.then(change).catch(err => {
    if (__DEV__) console.warn('Audio session change failed:', err);
  });
  return chain;
};

const recordMode = () => setAudioModeAsync({
  allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: false,
});

const playbackMode = async () => {
  await setAudioModeAsync({
    allowsRecording: false, playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: false,
  });
  AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default', iosOptions: [] });
};

const conversationMode = async () => {
  AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord', iosMode: 'voiceChat', iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
  });
  await AudioManager.setAudioSessionActivity(true);
};

// Nothing is held any more: back to the resting mode
const restoreIfIdle = () => (recordingOwner || conversationOwner || playbackHolders
  ? Promise.resolve()
  : enqueue(playbackMode));

const once = (release: () => Promise<void>): (() => Promise<void>) => {
  let done = false;
  return () => {
    if (done) return Promise.resolve();
    done = true;
    return release();
  };
};

export const isRecordingActive = (): boolean => recordingOwner !== null;

export const acquireRecording = async (owner: string): Promise<() => Promise<void>> => {
  recordingOwner = owner;
  conversationOwner = null;   // the Record tab wins over a conversation
  conversationToken++;
  notify();
  await enqueue(recordMode);
  return once(async () => {
    if (recordingOwner !== owner) return;
    recordingOwner = null;
    notify();
    await restoreIfIdle();
  });
};

export const acquirePlayback = async (owner: string): Promise<(() => Promise<void>) | null> => {
  if (recordingOwner) return null;
  playbackHolders++;
  // During a conversation the session already plays on the speaker: no mode change
  if (!conversationOwner && playbackHolders === 1) await enqueue(playbackMode);
  return once(async () => {
    playbackHolders = Math.max(0, playbackHolders - 1);
    await restoreIfIdle();
  });
};

export const acquireConversation = async (owner: string): Promise<(() => Promise<void>) | null> => {
  if (recordingOwner) return null;
  conversationOwner = owner;
  const token = ++conversationToken;
  notify();
  await enqueue(conversationMode);
  return once(async () => {
    if (token !== conversationToken) return;   // a recording took the session over
    conversationOwner = null;
    notify();
    await restoreIfIdle();
  });
};

export const onChange = (listener: (state: AudioSessionState) => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const __resetAudioSessionForTests = (): void => {
  recordingOwner = null;
  conversationOwner = null;
  conversationToken = 0;
  playbackHolders = 0;
  chain = Promise.resolve();
  listeners.clear();
};
