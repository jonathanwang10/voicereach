// T11: voice assistant client.
// H2-5.6: the mic streams over the socket; the server's input transcription fills the worker's bubble.
// C-25: answer text lands in its own bubble, even after a follow-up question.
// C-26: audio deltas are decoded one by one and pushed as they arrive.
// C-59: playback stops on mute/unmount, no GPS, sends need an OPEN socket.
// C-63: icon-only controls carry accessibility labels.
// H2-5.5: replies stream through the reply player once audioSession grants playback.
// T10 contract: only allowlisted events, tool items hidden, error events toasted, close codes explained.
import React from 'react';
import { Alert, AppState } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
// Tab focus: focused on mount; blurScreen()/focusScreen() run the focus effects' cleanup / callback.
const mockFocus = { callbacks: new Set<() => any>(), cleanups: new Map<() => any, any>() };
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: (cb: any) => React.useEffect(() => {
      mockFocus.callbacks.add(cb);
      mockFocus.cleanups.set(cb, cb());
      return () => {
        mockFocus.callbacks.delete(cb);
        mockFocus.cleanups.get(cb)?.();
        mockFocus.cleanups.delete(cb);
      };
    }, [cb]),
  };
});
jest.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, loading: false }) }));
jest.mock('../../services/api', () => ({
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
// The reply player: a fake that tracks the current item and its onDone like the real one.
const mockPlayer: any = {
  currentItem: null as string | null,
  onDone: null as null | (() => void),
  begin: jest.fn((id: string) => {
    if (mockPlayer.currentItem && mockPlayer.currentItem !== id) mockPlayer.stop();
    mockPlayer.currentItem = id;
  }),
  push: jest.fn(),
  play: jest.fn(),
  end: jest.fn((id: string, onDone: () => void) => {
    if (mockPlayer.currentItem !== id) onDone();
    else mockPlayer.onDone = onDone;
  }),
  stop: jest.fn(() => {
    const itemId = mockPlayer.currentItem;
    const done = mockPlayer.onDone;
    mockPlayer.currentItem = null;
    mockPlayer.onDone = null;
    done?.();
    return { itemId, playedMs: 0 };
  }),
  current: jest.fn(() => mockPlayer.currentItem),
  close: jest.fn(async () => {}),
  // test hook: the last buffer of the current item has played
  finish: () => {
    const done = mockPlayer.onDone;
    mockPlayer.currentItem = null;
    mockPlayer.onDone = null;
    done?.();
  },
};
jest.mock('../../services/replyPlayer', () => ({ createReplyPlayer: () => mockPlayer }));
const mockRelease = jest.fn(async () => {});
jest.mock('../../services/audioSession', () => ({
  acquirePlayback: jest.fn(async () => mockRelease),
  acquireConversation: jest.fn(async () => mockRelease),
  acquireRecording: jest.fn(),
  isRecordingActive: jest.fn(() => false),
  onChange: jest.fn((listener: any) => { mockSessionListener = listener; return () => {}; }),
}));
let mockSessionListener: (state: any) => void = () => {};
// The mic: the test sends frames through mockOnFrame
let mockOnFrame: (frame: string) => void = () => {};
const mockMicStop = jest.fn(async () => {});
jest.mock('../../services/micStream', () => ({
  startMicStream: jest.fn(async (onFrame: (frame: string) => void) => {
    mockOnFrame = onFrame;
    return { stop: mockMicStop };
  }),
}));
import Toast from 'react-native-toast-message';
import * as Location from 'expo-location';
import { acquireConversation, acquirePlayback } from '../../services/audioSession';
import { startMicStream } from '../../services/micStream';
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
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: any) => {
    mockAppStateHandler = handler;
    return { remove: jest.fn() };
  }) as any);
  mockPlayer.currentItem = null;
  mockPlayer.onDone = null;
});

let mockAppStateHandler: (state: string) => void = () => {};

const ALLOWED = new Set([
  'input_audio_buffer.append',
  'input_audio_buffer.commit',
  'input_audio_buffer.clear',
  'conversation.item.create',
  'response.create',
  'response.cancel',
  'conversation.item.truncate',
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

// base64 of `n` bytes of value `v` (n not a multiple of 3 gives '=' padding).
const b64 = (n: number, v = 7) => Buffer.from(new Uint8Array(n).fill(v)).toString('base64');
// Let the playback session request resolve
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const pushedBytes = (id: string) =>
  (mockPlayer.push as jest.Mock).mock.calls.filter(c => c[0] === id).map(c => Array.from(c[1] as Uint8Array));

async function startListening(screen: any) {
  await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
  await waitFor(() => expect(screen.getByLabelText('Stop recording question')).toBeTruthy());
}

async function stopListening(screen: any) {
  await act(async () => { fireEvent.press(screen.getByLabelText('Stop recording question')); });
}

const blurScreen = () => act(() => {
  mockFocus.callbacks.forEach(cb => { mockFocus.cleanups.get(cb)?.(); mockFocus.cleanups.delete(cb); });
});
const focusScreen = () => act(() => { mockFocus.callbacks.forEach(cb => mockFocus.cleanups.set(cb, cb())); });

const sentTypes = (ws: MockWebSocket) => ws.sent.map(e => e.type);
const toastTexts = () => (Toast.show as jest.Mock).mock.calls.map(c => `${c[0].text1} ${c[0].text2 ?? ''}`);

// Stream one spoken answer for item `id`: placeholder, transcript, audio (and its end, unless done=false).
function streamAnswer(ws: MockWebSocket, id: string, text: string, chunks = [b64(4801), b64(100)], done = true) {
  act(() => {
    ws.receive({ type: 'conversation.item.created', item: { id, type: 'message', role: 'assistant' } });
    ws.receive({ type: 'response.output_audio_transcript.delta', item_id: id, delta: text });
    for (const delta of chunks) ws.receive({ type: 'response.output_audio.delta', item_id: id, delta });
    if (done) ws.receive({ type: 'response.output_audio.done', item_id: id });
  });
}

// --- H2-5.6 streamed questions ---------------------------------------------------

describe('H2-5.6 streamed questions', () => {
  it('tapping the mic acquires the conversation session and streams frames as input_audio_buffer.append', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    expect(acquireConversation).toHaveBeenCalledWith('assistant');
    expect(startMicStream).toHaveBeenCalledTimes(1);
    act(() => { mockOnFrame('AAAA'); mockOnFrame('BBBB'); });
    expect(ws.sent).toEqual([
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
      { type: 'input_audio_buffer.append', audio: 'BBBB' },
    ]);
    expect(screen.getByText('Tap to stop')).toBeTruthy();
  });

  it('speech_started adds the worker bubble and the input transcription fills it', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u1' }));
    expect(screen.getByText('Recording your voice...')).toBeTruthy();
    act(() => ws.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' }));
    expect(screen.getByText('Processing your speech...')).toBeTruthy();
    act(() => ws.receive({
      type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Where is the shelter?' }));
    expect(screen.getByText('Where is the shelter?')).toBeTruthy();
    expect(screen.queryByText('Processing your speech...')).toBeNull();
  });

  it('a failed input transcription says so in the bubble', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => {
      ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
      ws.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
      ws.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'u1', error: {} });
    });
    expect(screen.getByText("[Couldn't transcribe]")).toBeTruthy();
  });

  it('stopping mid-speech commits the buffer and asks for a response', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u1' }));
    await stopListening(screen);
    expect(sentTypes(ws).slice(-2)).toEqual(['input_audio_buffer.commit', 'response.create']);
    expect(mockMicStop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    expect(screen.getByText('Tap to record')).toBeTruthy();
  });

  it('stopping after the turn ended clears the buffer', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => {
      ws.receive({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
      ws.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
    });
    await stopListening(screen);
    expect(ws.sent.at(-1)).toEqual({ type: 'input_audio_buffer.clear' });
  });

  it('no frames after the socket closes; the mic stops and the session is released', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => ws.serverClose(1011, ''));
    act(() => mockOnFrame('AAAA'));
    expect(ws.sent).toEqual([]);
    expect(mockMicStop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('Start recording question')).toBeTruthy());
  });

  it('leaving the tab stops listening', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    blurScreen();
    act(() => mockOnFrame('AAAA'));
    expect(ws.sent).toEqual([]);
    expect(mockMicStop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    expect(screen.getByLabelText('Start recording question')).toBeTruthy();
  });

  it.each(['background', 'inactive'])('going to the %s stops listening', async (state) => {
    const { screen } = await renderConnected();
    await startListening(screen);
    act(() => mockAppStateHandler(state));
    expect(mockMicStop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('a recording on the Record tab stops listening', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    act(() => mockSessionListener({ recordingOwner: 'record-tab', conversationOwner: null }));
    expect(mockMicStop).toHaveBeenCalled();
    act(() => mockOnFrame('AAAA'));
    expect(ws.sent).toEqual([]);
  });

  it('while the Record tab records, the mic does not start and says why', async () => {
    (acquireConversation as jest.Mock).mockResolvedValueOnce(null);
    const { screen } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    expect(startMicStream).not.toHaveBeenCalled();
    expect(toastTexts().join('\n')).toMatch(/Recording on the Record tab Finish that recording first\./);
    expect(screen.getByLabelText('Start recording question')).toBeTruthy();
  });

  it('a mic that fails to start releases the session and explains', async () => {
    (startMicStream as jest.Mock).mockRejectedValueOnce(new Error('Microphone permission denied'));
    const { screen } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    expect(mockRelease).toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Microphone', 'Could not start the microphone. Check the permission in Settings.');
    expect(screen.getByLabelText('Start recording question')).toBeTruthy();
  });

  it('a frame from a replaced socket is never sent on the new one', async () => {
    const { screen, ws } = await renderConnected();
    await startListening(screen);
    await act(async () => { fireEvent.press(screen.getByLabelText('Clear conversation')); });
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    const ws2 = MockWebSocket.instances[1];
    act(() => ws2.open());
    act(() => mockOnFrame('x'));
    expect(ws2.sent).toEqual([]);
    expect(ws.sent).toEqual([]);
    expect(mockMicStop).toHaveBeenCalled();
  });

  it('the mic never starts if the screen closed while the session was being acquired', async () => {
    let grant: (r: any) => void = () => {};
    (acquireConversation as jest.Mock).mockImplementationOnce(() => new Promise(r => { grant = r; }));
    const { screen } = await renderConnected();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    screen.unmount();
    await act(async () => { grant(mockRelease); });
    expect(startMicStream).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('unmount while listening stops the mic and releases the session', async () => {
    const { screen } = await renderConnected();
    await startListening(screen);
    screen.unmount();
    expect(mockMicStop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
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

  it('does not render function_call or function_call_output items', async () => {
    const { screen, ws } = await renderConnected();
    act(() => {
      for (const type of ['conversation.item.created', 'conversation.item.added']) {
        ws.receive({ type, item: { id: 'fc1', type: 'function_call', name: 'search_people', arguments: '{"query":"Ann"}' } });
        ws.receive({ type, item: { id: 'fo1', type: 'function_call_output', call_id: 'c1', output: 'REFERENCE DATA <<<[]>>>' } });
      }
    });
    expect(screen.queryByText(/search_people/)).toBeNull();
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

// --- H2-5.5, C-25, C-26: streamed replies -------------------------------------------

describe('streamed replies', () => {
  it('shows the transcript as it streams, before the audio is done', async () => {
    const { screen, ws } = await renderConnected();
    act(() => {
      ws.receive({ type: 'conversation.item.created', item: { id: 'a1', type: 'message', role: 'assistant' } });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'Stay ' });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(4800) });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: 'back.' });
    });
    expect(screen.getByText('Stay back.')).toBeTruthy();
    expect(mockPlayer.end).not.toHaveBeenCalled();
  });

  it('C-26: each audio delta, padded or not, is decoded on its own and pushed as it arrives', async () => {
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.', [b64(4801), b64(100)]);
    expect(pushedBytes('a1').map(b => b.length)).toEqual([4801, 100]);
    const pushOrder = (mockPlayer.push as jest.Mock).mock.invocationCallOrder;
    expect(Math.max(...pushOrder)).toBeLessThan((mockPlayer.end as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('plays only after the playback session is acquired', async () => {
    let grant: (r: any) => void = () => {};
    (acquirePlayback as jest.Mock).mockImplementationOnce(() => new Promise(r => { grant = r; }));
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.', [b64(4800)], false);
    expect(mockPlayer.begin).toHaveBeenCalledWith('a1');
    expect(acquirePlayback).toHaveBeenCalledWith('assistant');
    expect(mockPlayer.play).not.toHaveBeenCalled();
    await act(async () => { grant(mockRelease); });
    expect(mockPlayer.play).toHaveBeenCalledWith('a1');
  });

  it('a reply while the Record tab holds the session is text only', async () => {
    (acquirePlayback as jest.Mock).mockResolvedValueOnce(null);
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.', [b64(4800)], false);
    await settle();
    act(() => ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(4800) }));
    expect(mockPlayer.play).not.toHaveBeenCalled();
    expect(mockPlayer.push).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Stay back.')).toBeTruthy();
  });

  it('a playback session that arrives after the reply was muted is released, not used', async () => {
    let grant: (r: any) => void = () => {};
    (acquirePlayback as jest.Mock).mockImplementationOnce(() => new Promise(r => { grant = r; }));
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.', [b64(4800)], false);
    await act(async () => { fireEvent.press(screen.getByLabelText('Mute assistant voice')); });
    await act(async () => { grant(mockRelease); });
    expect(mockRelease).toHaveBeenCalled();
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('releases the playback session when the reply has played', async () => {
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.');
    await settle();
    expect(mockPlayer.play).toHaveBeenCalledWith('a1');
    expect(mockPlayer.end).toHaveBeenCalledWith('a1', expect.any(Function));
    expect(mockRelease).not.toHaveBeenCalled();
    act(() => mockPlayer.finish());
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', '[Speech response delivered]'],
    ['cancelled', '[Response interrupted]'],
  ])('response.done (%s) ends an item still playing and fills an empty bubble', async (status, fallback) => {
    const { screen, ws } = await renderConnected();
    act(() => {
      ws.receive({ type: 'conversation.item.created', item: { id: 'a1', type: 'message', role: 'assistant' } });
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(4800) });
    });
    await settle();
    act(() => ws.receive({ type: 'response.done', response: { status, output: [{ id: 'a1' }] } }));
    expect(mockPlayer.end).toHaveBeenCalledWith('a1', expect.any(Function));
    expect(screen.getByText(fallback)).toBeTruthy();
  });

  it('muting stops the reply, keeps its text, and later deltas are not pushed', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();
    await act(async () => { fireEvent.press(screen.getByLabelText('Mute assistant voice')); });
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    act(() => {
      ws.receive({ type: 'response.output_audio.delta', item_id: 'a1', delta: b64(4800) });
      ws.receive({ type: 'response.output_audio_transcript.delta', item_id: 'a1', delta: ' more' });
    });
    expect(mockPlayer.push).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Answer one more')).toBeTruthy();
  });

  it('unmount stops and closes the player', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();
    screen.unmount();
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockPlayer.close).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('a new answer stops the one still playing', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();
    streamAnswer(ws, 'a2', 'Answer two', [b64(4800)], false);
    await settle();
    expect((mockPlayer.begin as jest.Mock).mock.calls.map(c => c[0])).toEqual(['a1', 'a2']);
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);          // a1's session
    expect(screen.getByText('Answer one')).toBeTruthy();
  });

  it('writes no audio file', async () => {
    const FileSystem = require('expo-file-system');
    const { ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Stay back.');
    await settle();
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('C-25: answer 1 text lands in its own bubble after a follow-up question', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one');
    await settle();

    // The worker asks again while answer 1 is still playing.
    fireEvent.changeText(screen.getByPlaceholderText('Type your question here...'), 'Follow up');
    fireEvent.press(screen.getByLabelText('Send question'));
    act(() => mockPlayer.finish());

    expect(screen.getByText('Answer one')).toBeTruthy();
    expect(screen.getByText('Follow up')).toBeTruthy();
    expect(screen.queryByText('[Speaking...]')).toBeNull();
  });

  it('two interleaved answers keep their own text and their own audio', async () => {
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
      ws.receive({ type: 'response.output_audio.done', item_id: 'a2' });
    });
    await settle();

    // Each item's pushes hold only its own bytes; a1 stopped once a2 began
    expect(pushedBytes('a1').map(b => [...new Set(b)])).toEqual([[1]]);
    expect(pushedBytes('a2').map(b => [...new Set(b)])).toEqual([[2]]);
    // ...and each text its own bubble
    expect(screen.getByText('First answer')).toBeTruthy();
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

  it('Clear stops the reply that is playing and releases its session', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();
    await act(async () => { fireEvent.press(screen.getByLabelText('Clear conversation')); });
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  it('starting a voice question stops the reply and releases its session', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();
    await act(async () => { fireEvent.press(screen.getByLabelText('Start recording question')); });
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
});

// --- I-2: the Assistant tab stays mounted; it must not touch the audio session when blurred ---

describe('I-2 not focused', () => {
  it('a reply while another tab is focused shows text only: no session request, no playback', async () => {
    const { screen, ws } = await renderConnected();
    blurScreen();
    streamAnswer(ws, 'a1', 'Answer while away');
    await settle();

    expect(screen.getByText('Answer while away')).toBeTruthy();
    expect(acquirePlayback).not.toHaveBeenCalled();
    expect(mockPlayer.begin).not.toHaveBeenCalled();
    expect(mockPlayer.play).not.toHaveBeenCalled();
  });

  it('leaving the tab stops the reply that is playing, keeping its text', async () => {
    const { screen, ws } = await renderConnected();
    streamAnswer(ws, 'a1', 'Answer one', [b64(4800)], false);
    await settle();

    blurScreen();
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    expect(screen.getByText('Answer one')).toBeTruthy();
  });

  it('plays replies again once the tab is focused again', async () => {
    const { ws } = await renderConnected();
    blurScreen();
    focusScreen();

    streamAnswer(ws, 'a2', 'Back again');
    await settle();
    expect(mockPlayer.play).toHaveBeenCalledWith('a2');
  });
});
