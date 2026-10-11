// T11: voice assistant client.
// C-63: icon-only controls carry accessibility labels.
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
