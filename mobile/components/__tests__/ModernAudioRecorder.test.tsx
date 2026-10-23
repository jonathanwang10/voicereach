import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

// A fake expo-audio recorder whose status the test drives: record()/stop() flip
// isRecording, and at(ms) sets the recorder's own durationMillis (H2-5.3).
let mockState: any = {};
const mockRecorder = {
  prepareToRecordAsync: jest.fn(async () => {}),
  record: jest.fn(() => { mockState.isRecording = true; }),
  stop: jest.fn(async () => { mockState.isRecording = false; }),
  uri: 'file://a.m4a',
};
jest.mock('expo-audio', () => {
  const ReactActual = jest.requireActual('react');
  return {
    useAudioRecorder: jest.fn(() => mockRecorder),
    useAudioRecorderState: jest.fn(() => {
      const [, bump] = ReactActual.useReducer((n: number) => n + 1, 0);
      ReactActual.useEffect(() => {
        const id = setInterval(bump, 500);
        return () => clearInterval(id);
      }, []);
      return { ...mockState };
    }),
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
    IOSOutputFormat: { MPEG4AAC: 'aac ' },
    AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
  };
});
const mockRelease = jest.fn(async () => {});
jest.mock('../../services/audioSession', () => ({ acquireRecording: jest.fn(async () => mockRelease) }));
jest.mock('expo-file-system', () => ({ deleteAsync: jest.fn(async () => {}) }));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(async () => [{ street: '5th St', city: 'San Francisco', region: 'CA' }]),
  Accuracy: { High: 4 },
}));

import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { useAudioRecorder } from 'expo-audio';
import { acquireRecording } from '../../services/audioSession';
import { ModernAudioRecorder, LOCATION_WAIT_MS } from '../ModernAudioRecorder';
import { theme } from '../../theme';

const press = async (screen: ReturnType<typeof render>) => {
  await act(async () => { fireEvent.press(screen.getByTestId('record-button')); });
};
const tick = async (ms: number) => {
  await act(async () => { jest.advanceTimersByTime(ms); });
};
// The recorder reports `ms` recorded; the state hook picks it up on its next poll
const at = async (ms: number) => {
  mockState.durationMillis = ms;
  await tick(500);
};
const lastAlert = () => (Alert.alert as jest.Mock).mock.calls.at(-1);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockState = { isRecording: false, durationMillis: 0, mediaServicesDidReset: false, canRecord: true, url: null };
  mockRecorder.uri = 'file://a.m4a';
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
});
afterEach(() => jest.useRealTimers());

it('records 16 kHz mono AAC at 32 kbps', () => {
  render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  expect(useAudioRecorder).toHaveBeenCalledWith(expect.objectContaining({
    extension: '.m4a', sampleRate: 16000, numberOfChannels: 1, bitRate: 32000 }));
});

it("the timer follows the recorder's status", async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(65_000);
  expect(screen.getByText('1:05')).toBeTruthy();
});

it('acquires the recording session before preparing, and releases it on stop', async () => {
  const order: string[] = [];
  (acquireRecording as jest.Mock).mockImplementationOnce(async () => { order.push('acquire'); return mockRelease; });
  mockRecorder.prepareToRecordAsync.mockImplementationOnce(async () => { order.push('prepare'); });
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  expect(order).toEqual(['acquire', 'prepare']);
  await at(6_000);
  await press(screen); // stop
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

it('releases the session when starting fails', async () => {
  mockRecorder.prepareToRecordAsync.mockRejectedValueOnce(new Error('mic busy'));
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Tap to start recording')).toBeTruthy();
});

it('releases the session on unmount while recording', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  screen.unmount();
  await act(async () => {});
  expect(mockRecorder.stop).toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalled();
});

it('an interruption stops the recording, keeps the audio and says so', async () => {
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(42_000);
  mockState.isRecording = false;          // a call or Siri paused the recorder
  await tick(500);
  expect(mockRecorder.stop).toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith('Recording interrupted',
    'Recording was interrupted at 0:42. You can keep what was recorded or record again.',
    [expect.objectContaining({ text: 'Record again' }), expect.objectContaining({ text: 'Keep' })]);
  await act(async () => { lastAlert()[2].find((b: any) => b.text === 'Keep').onPress(); });
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
  expect(screen.getByText('Tap to start recording')).toBeTruthy();
});

it('an interruption before 5 s offers only Record again, which deletes the file', async () => {
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(3_000);
  mockState.isRecording = false;
  await tick(500);
  const buttons = lastAlert()[2];
  expect(buttons.map((b: any) => b.text)).toEqual(['Record again']);
  await act(async () => { buttons[0].onPress(); });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file://a.m4a', { idempotent: true });
  expect(onComplete).not.toHaveBeenCalled();
});

it('a media services reset counts as an interruption', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(20_000);
  mockState.mediaServicesDidReset = true;
  await tick(500);
  expect(lastAlert()[0]).toBe('Recording interrupted');
});

it('the first status poll before recording starts is not an interruption', async () => {
  mockRecorder.record.mockImplementationOnce(() => {});   // status still says "not recording"
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await tick(500);
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

it('warns once at 1:45', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(105_000);
  await at(105_500);
  await at(106_000);
  expect((Alert.alert as jest.Mock).mock.calls.filter(c => c[0] === '⏱️ Time Warning')).toHaveLength(1);
});

it('auto-stops at 2:00 and reports the recording', async () => {
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(120_000);
  expect(mockRecorder.stop).toHaveBeenCalled();
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
});

// C-39: the worker starts talking on tap, so the recording must not wait for GPS
it('starts recording before the GPS fix arrives', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  expect(mockRecorder.record).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

// C-39: the fix captured in parallel is handed over with the recording
it('reports the location captured while recording', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({ coords: { latitude: 37.7, longitude: -122.4 } });
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(6_000);
  await press(screen); // stop
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', {
    location: { latitude: 37.7, longitude: -122.4, address: '5th St San Francisco CA' },
  });
});

// C-39: a slow fix delays the hand-over by at most LOCATION_WAIT_MS, then it goes without
it('waits only a short time for a pending fix at stop', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockReturnValue(new Promise(() => {}));
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(6_000);
  await press(screen); // stop
  expect(onComplete).not.toHaveBeenCalled();
  await tick(LOCATION_WAIT_MS);
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
});

// C-39: a second tap while the recorder is still starting is ignored
it('ignores taps while starting', async () => {
  let finishPrepare: () => void = () => {};
  mockRecorder.prepareToRecordAsync.mockReturnValueOnce(new Promise<void>(r => { finishPrepare = r; }));
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await press(screen);
  expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
  await act(async () => finishPrepare());
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

// C-61: the timer turns red at 1:30 (PRD), not 1:45
it('turns the timer red at 1:30', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(89_000);
  expect(StyleSheet.flatten(screen.getByText('1:29').props.style).color).not.toBe(theme.colors.danger[600]);
  await at(90_000);
  expect(StyleSheet.flatten(screen.getByText('1:30').props.style).color).toBe(theme.colors.danger[600]);
});

it('says "Too Short" under 5 s and keeps recording', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(3_000);
  await press(screen); // too early
  expect(lastAlert()[0]).toBe('⏱️ Too Short');
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

// C-61: a failed stop must not leave the UI stuck on the stop button
it('returns to the idle state when stopping fails', async () => {
  mockRecorder.stop.mockRejectedValueOnce(new Error('boom'));
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(6_000);
  await press(screen); // stop fails
  expect(onComplete).not.toHaveBeenCalled();
  expect(screen.getByText('Tap to start recording')).toBeTruthy();
  expect(screen.getByText('0:00')).toBeTruthy();
  expect(mockRelease).toHaveBeenCalled();
});

// Fix round 1 (#2): the stop wait shows feedback and blocks the button
it('shows "Saving location..." and disables the button while waiting for the fix', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockReturnValue(new Promise(() => {}));
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await at(6_000);
  await press(screen); // stop
  expect(screen.getByText('Saving location...')).toBeTruthy();
  expect(screen.getByTestId('record-button').props.accessibilityState?.disabled).toBe(true);
  await tick(LOCATION_WAIT_MS);
  expect(onComplete).toHaveBeenCalled();
  expect(screen.getByText('Tap to start recording')).toBeTruthy();
});

// Fix round 1 (#4): unmounting while the recorder starts must not leave the mic on
it('stops a recording that finishes starting after unmount', async () => {
  let finishPrepare: () => void = () => {};
  mockRecorder.prepareToRecordAsync.mockReturnValueOnce(new Promise<void>(r => { finishPrepare = r; }));
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  screen.unmount();
  await act(async () => finishPrepare());
  expect(mockRecorder.record).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
});

// Fix round 1 (#6): a failed stop gets one more best-effort stop, so the next start isn't blocked
it('retries the stop once when stopping fails', async () => {
  mockRecorder.stop.mockRejectedValueOnce(new Error('boom'));
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await at(6_000);
  await press(screen); // stop fails
  expect(mockRecorder.stop).toHaveBeenCalledTimes(2);
});
