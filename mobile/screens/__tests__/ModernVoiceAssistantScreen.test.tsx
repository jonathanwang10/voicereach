// T11: voice assistant client.
// C-23: a failed or empty transcription sends nothing and says so.
// C-24: replies play with iOS recording mode off (speaker, not earpiece).
// C-25: answer text lands in its own bubble, even after a follow-up question.
// C-26: audio deltas are decoded one by one and joined as bytes.
// C-59: playback is unloaded on mute/unmount/error, no GPS, sends need an OPEN socket.
// C-63: icon-only controls carry accessibility labels.
// T10 contract: only allowlisted events, ctx_ items hidden, error events toasted, close codes explained.
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, loading: false }) }));
jest.mock('../../services/api', () => ({
  api: { transcribeForAssistant: jest.fn() },
  getAuthToken: jest.fn().mockResolvedValue('tok'),
}));
jest.mock('../../config/api', () => ({ API_CONFIG: { BASE_URL: 'http://test.local:8001' } }));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { High: 4 },
}));
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
}));
// Test hooks for the recorder: hold prepareToRecordAsync, or make stopAndUnloadAsync fail.
let mockPrepare: () => Promise<void> = () => Promise.resolve();
let mockStop: () => Promise<void> = () => Promise.resolve();
const mockRecordings: any[] = [];
jest.mock('expo-av', () => {
  class Recording {
    prepareToRecordAsync = jest.fn(() => mockPrepare());
    startAsync = jest.fn().mockResolvedValue(undefined);
    stopAndUnloadAsync = jest.fn(() => mockStop());
    getURI = () => 'file:///question.m4a';
    constructor() {
      mockRecordings.push(this);
    }
  }
  return {
    Audio: {
      Recording,
      setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
      requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
      Sound: { createAsync: jest.fn() },
      AndroidOutputFormat: { MPEG_4: 2 },
      AndroidAudioEncoder: { AAC: 3 },
      IOSOutputFormat: { MPEG4AAC: 'aac' },
      IOSAudioQuality: { MEDIUM: 64 },
      RecordingOptionsPresets: { LOW_QUALITY: {} },
    },
  };
});

import Toast from 'react-native-toast-message';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import { api } from '../../services/api';
import { ModernVoiceAssistantScreen } from '../ModernVoiceAssistantScreen';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: any[] = [];
  onopen: any = null;
  onclose: any = null;
  onerror: any = null;
  onmessage: any = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send = jest.fn((frame: string) => {
    this.sent.push(JSON.parse(frame));
  });
  close = jest.fn(() => {
    this.readyState = 3;
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: any) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const realWebSocket = (global as any).WebSocket;
beforeAll(() => {
  (global as any).WebSocket = MockWebSocket;
});
afterAll(() => {
  (global as any).WebSocket = realWebSocket;
});

beforeEach(() => {
  jest.clearAllMocks();
  MockWebSocket.instances = [];
  mockRecordings.length = 0;
  mockPrepare = () => Promise.resolve();
  mockStop = () => Promise.resolve();
});

const ALLOWED = new Set([
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'conversation.item.create',
  'response.create',
  'response.cancel',
]);

// Render and open the socket; returns the live socket.
async function renderConnected() {
  const screen = render(<ModernVoiceAssistantScreen />);
  await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
  const ws = MockWebSocket.instances[0];
  act(() => ws.open());
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  return { screen, ws };
}

describe('C-63 accessibility labels', () => {
  it('labels every icon-only control', async () => {
    const { screen } = await renderConnected();
    expect(screen.getByLabelText('Mute assistant voice')).toBeTruthy();
    expect(screen.getByLabelText('Reconnect voice assistant')).toBeTruthy();
    expect(screen.getByLabelText('Clear conversation')).toBeTruthy();
    expect(screen.getByLabelText('Send question')).toBeTruthy();
    expect(screen.getByLabelText('Start recording question')).toBeTruthy();
  });
});

// --- helpers ---------------------------------------------------------------

const sound = () => {
  let onStatus: any = null;
  const s: any = {
    setOnPlaybackStatusUpdate: jest.fn((cb: any) => { onStatus = cb; }),
    playAsync: jest.fn().mockResolvedValue(undefined),
    unloadAsync: jest.fn().mockResolvedValue(undefined),
    finish: () => onStatus?.({ isLoaded: true, didJustFinish: true }),
  };
  return s;
};

// base64 of `n` bytes of value `v` (n not a multiple of 3 gives '=' padding).
const b64 = (n: number, v = 7) => Buffer.from(new Uint8Array(n).fill(v)).toString('base64');
// Chunks whose sizes are multiples of 3 have no '=' padding, so tests using them don't
// depend on the C-26 per-chunk decoding (they would pass with text joining too).
const UNPADDED = [b64(4800), b64(99)];

async function askByVoice(screen: any) {
  await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
  await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByLabelText('Stop recording question')); });
  await waitFor(() => expect(screen.queryByLabelText('Processing question')).toBeNull());
}

const sentTypes = (ws: MockWebSocket) => ws.sent.map(e => e.type);
const toastTexts = () => (Toast.show as jest.Mock).mock.calls.map(c => `${c[0].text1} ${c[0].text2 ?? ''}`);

// Stream one spoken answer for item `id`: placeholder, transcript, audio.
function streamAnswer(ws: MockWebSocket, id: string, text: string, chunks = [b64(4801), b64(100)]) {
  act(() => {
    ws.receive({ type: 'conversation.item.created', item: { id, type: 'message', role: 'assistant' } });
    ws.receive({ type: 'response.output_audio_transcript.delta', item_id: id, delta: text });
    for (const delta of chunks) ws.receive({ type: 'response.output_audio.delta', item_id: id, delta });
    ws.receive({ type: 'response.output_audio.done', item_id: id });
  });
}

// --- C-23 ------------------------------------------------------------------

describe('C-23 failed transcription', () => {
  it('a transcription error sends nothing, shows no invented question, and says so', async () => {
    (api.transcribeForAssistant as jest.Mock).mockRejectedValue(new Error('Request timed out'));
    const { screen, ws } = await renderConnected();
    await askByVoice(screen);

    expect(ws.send).not.toHaveBeenCalled();
    expect(screen.queryByText(/I need help with homeless outreach guidance/)).toBeNull();
    expect(screen.queryByText('[Processing your speech...]')).toBeNull();
    expect(toastTexts().join('\n')).toMatch(/Couldn't transcribe, please try again/);
  });

  it('an empty transcript sends nothing', async () => {
    (api.transcribeForAssistant as jest.Mock).mockResolvedValue('   ');
    const { screen, ws } = await renderConnected();
    await askByVoice(screen);

    expect(ws.send).not.toHaveBeenCalled();
    expect(toastTexts().join('\n')).toMatch(/Couldn't transcribe, please try again/);
  });

  it('a short real answer ("OK") is sent with response.create', async () => {
    (api.transcribeForAssistant as jest.Mock).mockResolvedValue('OK');
    const { screen, ws } = await renderConnected();
    await askByVoice(screen);

    expect(sentTypes(ws)).toEqual(['conversation.item.create', 'response.create']);
    expect(ws.sent[0].item.content[0].text).toBe('OK');
    expect(screen.getByText('OK')).toBeTruthy();
  });

  it('if the socket closed meanwhile, nothing is sent and the question goes back in the text box', async () => {
    let resolve: (t: string) => void = () => {};
    (api.transcribeForAssistant as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { screen, ws } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByLabelText('Stop recording question')); });
    act(() => ws.serverClose(1011, 'Upstream unavailable'));
    await act(async () => { resolve('Where is the shelter?'); });

    expect(ws.send).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Where is the shelter?')).toBeTruthy();
    expect(toastTexts().join('\n')).not.toMatch(/Failed to stop recording/);
  });
});

// --- T10 contract ------------------------------------------------------------

describe('T10 WebSocket contract', () => {
  it('a typed question sends only allowlisted events, never session.update', async () => {
    const { screen, ws } = await renderConnected();
    fireEvent.changeText(screen.getByPlaceholderText('Type your question here...'), 'Hello');
    fireEvent.press(screen.getByLabelText('Send question'));

    expect(sentTypes(ws)).toEqual(['conversation.item.create', 'response.create']);
    expect(ws.sent.every(e => ALLOWED.has(e.type))).toBe(true);
    expect(ws.sent[1]).toEqual({ type: 'response.create' });
  });

  it('does not render the injected ctx_ reference-data item', async () => {
    const { screen, ws } = await renderConnected();
    act(() => {
      for (const type of ['conversation.item.created', 'conversation.item.added']) {
        ws.receive({
          type,
          item: {
            id: 'ctx_0123456789abcdef01234567', type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'REFERENCE DATA (from the case database) <<<{}>>>' }],
          },
        });
      }
    });
    expect(screen.queryByText(/REFERENCE DATA/)).toBeNull();
    expect(screen.queryByText('[Speaking...]')).toBeNull();
  });

  it('shows a server error event as a short toast, not a permanent error card', async () => {
    const { screen, ws } = await renderConnected();
    act(() => ws.receive({
      type: 'error', error: { type: 'invalid_request_error', code: 'event_not_allowed', message: 'Event type not allowed' },
    }));
    expect(toastTexts().join('\n')).toMatch(/Event type not allowed/);
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it.each([
    [1008, 'Session time limit reached', /Session time limit reached/],
    [1011, '', /unavailable/i],
    [1006, "Expected HTTP 101 response but was '403 Forbidden'", /not allowed/i],
  ])('close %s shows a short message and does not auto-reconnect', async (code, reason, expected) => {
    const { screen, ws } = await renderConnected();
    act(() => ws.serverClose(code as number, reason as string));
    await waitFor(() => expect(screen.getByText(expected as RegExp)).toBeTruthy());
    expect(screen.getByText('Disconnected')).toBeTruthy();
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('session.created clears an earlier connection error', async () => {
    const { screen } = await renderConnected();
    act(() => MockWebSocket.instances[0].serverClose(1011, ''));
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('Retry')); });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    const ws2 = MockWebSocket.instances[1];
    act(() => { ws2.open(); ws2.receive({ type: 'session.created', session: {} }); });
    await waitFor(() => expect(screen.queryByText('Retry')).toBeNull());
  });
});

// --- C-24, C-25, C-26 ----------------------------------------------------------

describe('spoken answers', () => {
  it('C-26: padded audio deltas still play, as one WAV of the joined bytes', async () => {
    const s = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: s });
    const FileSystem = require('expo-file-system');
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.');

    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1));
    const wavB64 = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0][1];
    expect(Buffer.from(wavB64, 'base64').length).toBe(44 + 4801 + 100);
  });

  it('C-24: switches iOS recording mode off before playing the reply', async () => {
    const s = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: s });
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.', UNPADDED);
    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalled());

    const modeCalls = (Audio.setAudioModeAsync as jest.Mock).mock;
    const idx = modeCalls.calls.findIndex(c => c[0].allowsRecordingIOS === false && c[0].playsInSilentModeIOS === true);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(modeCalls.invocationCallOrder[idx]).toBeLessThan(
      (Audio.Sound.createAsync as jest.Mock).mock.invocationCallOrder[0]
    );
  });

  it('C-25: answer 1 text lands in its own bubble after a follow-up question', async () => {
    const s = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: s });
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', UNPADDED);
    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalled());

    // The worker asks again while answer 1 is still playing.
    fireEvent.changeText(screen.getByPlaceholderText('Type your question here...'), 'Follow up');
    fireEvent.press(screen.getByLabelText('Send question'));
    await act(async () => { s.finish(); });

    await waitFor(() => expect(screen.getByText('Answer one')).toBeTruthy());
    expect(screen.queryByText('[Speaking...]')).toBeNull();
  });

  it('two interleaved answers keep their own text and their own audio', async () => {
    const s1 = sound();
    const s2 = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValueOnce({ sound: s1 }).mockResolvedValueOnce({ sound: s2 });
    const FileSystem = require('expo-file-system');
    const { screen, ws } = await renderConnected();
    act(() => {
      for (const id of ['a1', 'a2']) {
        ws.receive({ type: 'conversation.item.created', item: { id, type: 'message', role: 'assistant' } });
      }
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'First ' });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a2', delta: 'Second ' });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(2400, 1) });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a2', delta: b64(6000, 2) });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'answer' });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a2', delta: 'answer' });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(2400, 1) });
      ws.receive({ type: 'response.output_audio.done', item_id: 'a1' });
    });
    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1));
    act(() => ws.receive({ type: 'response.output_audio.done', item_id: 'a2' }));
    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(2));
    await act(async () => { s2.finish(); });

    // Each WAV holds only its own item's bytes (unpadded chunks; 4800 bytes is the playable minimum)
    const wavs = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls.map(c => Buffer.from(c[1], 'base64'));
    expect(wavs.map(w => w.length)).toEqual([44 + 4800, 44 + 6000]);
    expect([...new Set(wavs[0].subarray(44))]).toEqual([1]);
    expect([...new Set(wavs[1].subarray(44))]).toEqual([2]);
    // ...and each text its own bubble
    await waitFor(() => expect(screen.getByText('First answer')).toBeTruthy());
    expect(screen.getByText('Second answer')).toBeTruthy();
    expect(screen.queryByText(/First Second|Second First/)).toBeNull();
  });
});

describe('C-63 status colours', () => {
  const { StyleSheet } = require('react-native');
  const { theme } = require('../../theme');
  const colourValues = (screen: any): string[] =>
    screen.UNSAFE_root.findAll((n: any) => typeof n.type === 'string' && n.props.style)
      .flatMap((n: any) => Object.values(StyleSheet.flatten(n.props.style) || {}))
      .filter((v: any) => typeof v === 'string');

  it('never uses currentColor, which React Native does not support', async () => {
    const { screen, ws } = await renderConnected();
    expect(colourValues(screen)).not.toContain('currentColor');
    act(() => ws.serverClose(1011, ''));
    await waitFor(() => expect(screen.getByText('Disconnected')).toBeTruthy());
    expect(colourValues(screen)).not.toContain('currentColor');
  });

  it('colours the status text green when connected and red when not', async () => {
    const { screen, ws } = await renderConnected();
    expect(StyleSheet.flatten(screen.getByText('Connected').props.style).color).toBe(theme.colors.success[600]);
    act(() => ws.serverClose(1011, ''));
    await waitFor(() => expect(screen.getByText('Disconnected')).toBeTruthy());
    expect(StyleSheet.flatten(screen.getByText('Disconnected').props.style).color).toBe(theme.colors.danger[600]);
  });
});

// --- C-59 ----------------------------------------------------------------------

describe('C-59 lifecycle', () => {
  it('does not ask for GPS', async () => {
    await renderConnected();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('muting stops and unloads the reply, keeping its text', async () => {
    const s = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: s });
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one');
    await waitFor(() => expect(s.playAsync).toHaveBeenCalled());

    await act(async () => { fireEvent.press(screen.getByLabelText('Mute assistant voice')); });
    expect(s.unloadAsync).toHaveBeenCalled();
    expect(screen.getByText('Answer one')).toBeTruthy();
  });

  it('unmount unloads the playing reply', async () => {
    const s = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: s });
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one');
    await waitFor(() => expect(s.playAsync).toHaveBeenCalled());

    screen.unmount();
    expect(s.unloadAsync).toHaveBeenCalled();
  });

  it('a playback error deletes the WAV and still shows the text', async () => {
    (Audio.Sound.createAsync as jest.Mock).mockRejectedValue(new Error('decoder'));
    const FileSystem = require('expo-file-system');
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one');

    await waitFor(() => expect(screen.getByText('Answer one')).toBeTruthy());
    const written = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0][0];
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith(written, { idempotent: true });
  });

  it('a new answer stops the one still playing', async () => {
    const s1 = sound();
    const s2 = sound();
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValueOnce({ sound: s1 }).mockResolvedValueOnce({ sound: s2 });
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one');
    await waitFor(() => expect(s1.playAsync).toHaveBeenCalled());
    streamAnswer(ws, 'a2', 'Answer two');
    await waitFor(() => expect(s2.playAsync).toHaveBeenCalled());

    expect(s1.unloadAsync).toHaveBeenCalled();
    expect(screen.getByText('Answer one')).toBeTruthy();
  });

  it('does not send on a socket that is still connecting', async () => {
    const screen = render(<ModernVoiceAssistantScreen />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
    ws.readyState = 0; // e.g. a reconnect in flight
    fireEvent.changeText(screen.getByPlaceholderText('Type your question here...'), 'Hello');
    fireEvent.press(screen.getByLabelText('Send question'));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Clear also starts a fresh server conversation', async () => {
    const { screen, ws } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Clear conversation')); });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    expect(ws.close).toHaveBeenCalled();
  });
});

// --- T14 carried items ----------------------------------------------------------

describe('T14: recording start, interrupted replies, late transcripts, cached files', () => {
  it('a reply that finishes while recording is starting does not switch the audio mode to playback', async () => {
    let grant: (v: any) => void = () => {};
    (Audio.requestPermissionsAsync as jest.Mock).mockImplementationOnce(() => new Promise(r => { grant = r; }));
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: sound() });
    const { screen, ws } = await renderConnected();

    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    streamAnswer(ws, 'a1', 'Stay back.');          // arrives while recording mode is being set up
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });

    expect(Audio.Sound.createAsync).not.toHaveBeenCalled();
    expect((Audio.setAudioModeAsync as jest.Mock).mock.calls.some(c => c[0].allowsRecordingIOS === false)).toBe(false);
    expect(screen.getByText('Stay back.')).toBeTruthy(); // its text still shows

    await act(async () => { grant({ status: 'granted' }); });
    await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
  });

  it("response.done drops the audio of an interrupted item, so it can't play later", async () => {
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: sound() });
    const { ws } = await renderConnected();
    act(() => {
      ws.receive({ type: 'conversation.item.created', item: { id: 'a1', type: 'message', role: 'assistant' } });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(4800) });
      ws.receive({ type: 'response.done', response: { status: 'cancelled', output: [{ id: 'a1' }] } });
      // A stray late done for the same item finds nothing buffered.
      ws.receive({ type: 'response.output_audio.done', item_id: 'a1' });
    });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(Audio.Sound.createAsync).not.toHaveBeenCalled();
  });

  it('a transcript that arrives after the screen closed changes nothing and sends nothing', async () => {
    let resolve: (t: string) => void = () => {};
    (api.transcribeForAssistant as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { screen, ws } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByLabelText('Stop recording question')); });

    screen.unmount();
    (Toast.show as jest.Mock).mockClear();
    await act(async () => { resolve('Where is the shelter?'); });

    expect(ws.send).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('a transcript for the old socket is not sent on the new one after Clear', async () => {
    let resolve: (t: string) => void = () => {};
    (api.transcribeForAssistant as jest.Mock).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { screen, ws } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByLabelText('Stop recording question')); });

    await act(async () => { fireEvent.press(screen.getByLabelText('Clear conversation')); });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    const ws2 = MockWebSocket.instances[1];
    act(() => ws2.open());
    await act(async () => { resolve('Where is the shelter?'); });

    expect(ws.send).not.toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Where is the shelter?')).toBeTruthy();
    expect(toastTexts().join('\n')).toMatch(/conversation was restarted/);
  });

  it.each([
    ['transcribed', () => (api.transcribeForAssistant as jest.Mock).mockResolvedValue('OK')],
    ['failed', () => (api.transcribeForAssistant as jest.Mock).mockRejectedValue(new Error('Request timed out'))],
  ])('the recorded question file is deleted from the cache once %s (C-65)', async (_label, arrange) => {
    (arrange as () => void)();
    const FileSystem = require('expo-file-system');
    const { screen } = await renderConnected();
    await askByVoice(screen);
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///question.m4a', { idempotent: true });
  });
});

// --- T14 fix round 1 -------------------------------------------------------------

describe('T14 fix round 1: the microphone never outlives the screen', () => {
  it('leaving the screen while the recorder is being prepared stops it and deletes its file', async () => {
    let release: () => void = () => {};
    mockPrepare = () => new Promise<void>(r => { release = r; });
    const FileSystem = require('expo-file-system');
    const { screen } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    await waitFor(() => expect(mockRecordings.length).toBe(1));

    screen.unmount();
    await act(async () => { release(); });

    const rec = mockRecordings[0];
    expect(rec.startAsync).not.toHaveBeenCalled();
    expect(rec.stopAndUnloadAsync).toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///question.m4a', { idempotent: true });
  });

  it('leaving the screen during the permission prompt never creates a recorder', async () => {
    let grant: (v: any) => void = () => {};
    (Audio.requestPermissionsAsync as jest.Mock).mockImplementationOnce(() => new Promise(r => { grant = r; }));
    const { screen } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });

    screen.unmount();
    await act(async () => { grant({ status: 'granted' }); });

    expect(mockRecordings.filter(r => r.startAsync.mock.calls.length > 0)).toHaveLength(0);
  });

  it('if stopping the recorder fails, its file is still deleted', async () => {
    mockStop = () => Promise.reject(new Error('stop failed'));
    const FileSystem = require('expo-file-system');
    const { screen, ws } = await renderConnected();
    await askByVoice(screen);

    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///question.m4a', { idempotent: true });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
