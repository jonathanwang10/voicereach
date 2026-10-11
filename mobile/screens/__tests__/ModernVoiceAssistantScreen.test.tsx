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
jest.mock('expo-av', () => {
  class Recording {
    prepareToRecordAsync = jest.fn().mockResolvedValue(undefined);
    startAsync = jest.fn().mockResolvedValue(undefined);
    stopAndUnloadAsync = jest.fn().mockResolvedValue(undefined);
    getURI = () => 'file:///question.m4a';
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
    streamAnswer(ws, 'a1', 'Stay back.');
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
    streamAnswer(ws, 'a1', 'Answer one');
    await waitFor(() => expect(Audio.Sound.createAsync).toHaveBeenCalled());

    // The worker asks again while answer 1 is still playing.
    fireEvent.changeText(screen.getByPlaceholderText('Type your question here...'), 'Follow up');
    fireEvent.press(screen.getByLabelText('Send question'));
    await act(async () => { s.finish(); });

    await waitFor(() => expect(screen.getByText('Answer one')).toBeTruthy());
    expect(screen.queryByText('[Speaking...]')).toBeNull();
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
