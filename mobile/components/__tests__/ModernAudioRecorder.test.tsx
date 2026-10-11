import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

const mockStopAndUnloadAsync = jest.fn(async () => {});
const mockCreateAsync = jest.fn(async (..._args: any[]) => ({
  recording: { stopAndUnloadAsync: mockStopAndUnloadAsync, getURI: () => 'file://a.m4a' },
}));
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    setAudioModeAsync: jest.fn(async () => {}),
    Recording: { createAsync: (...args: any[]) => mockCreateAsync(...args) },
    RecordingOptionsPresets: { LOW_QUALITY: { android: {}, ios: {}, web: {} } },
    AndroidOutputFormat: { MPEG_4: 2 }, AndroidAudioEncoder: { AAC: 3 },
  },
}));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(async () => [{ street: '5th St', city: 'San Francisco', region: 'CA' }]),
  Accuracy: { High: 4 },
}));

import * as Location from 'expo-location';
import { ModernAudioRecorder, LOCATION_WAIT_MS } from '../ModernAudioRecorder';
import { theme } from '../../theme';

const press = async (screen: ReturnType<typeof render>) => {
  await act(async () => { fireEvent.press(screen.getByTestId('record-button')); });
};
const tick = async (ms: number) => {
  await act(async () => { jest.advanceTimersByTime(ms); });
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
});
afterEach(() => jest.useRealTimers());

it('auto-stops at 2:00 and reports the recording', async () => {
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await tick(121_000);
  expect(mockStopAndUnloadAsync).toHaveBeenCalled();
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
});

// C-39: the worker starts talking on tap, so the recording must not wait for GPS
it('starts recording before the GPS fix arrives', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

// C-39: the fix captured in parallel is handed over with the recording
it('reports the location captured while recording', async () => {
  (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
  (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({ coords: { latitude: 37.7, longitude: -122.4 } });
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await tick(6_000);
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
  await tick(6_000);
  await press(screen); // stop
  expect(onComplete).not.toHaveBeenCalled();
  await tick(LOCATION_WAIT_MS);
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
});

// C-39: a second tap while the recorder is still starting is ignored
it('ignores taps while starting', async () => {
  let finishCreate: (v: any) => void = () => {};
  mockCreateAsync.mockReturnValueOnce(new Promise(r => { finishCreate = r; }) as any);
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await press(screen);
  expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  await act(async () => finishCreate({
    recording: { stopAndUnloadAsync: mockStopAndUnloadAsync, getURI: () => 'file://a.m4a' },
  }));
  expect(screen.getByText('Recording in progress...')).toBeTruthy();
});

// C-61: the timer turns red at 1:30 (PRD), not 1:45
it('turns the timer red at 1:30', async () => {
  const screen = render(<ModernAudioRecorder onRecordingComplete={jest.fn()} />);
  await press(screen);
  await tick(89_000);
  expect(StyleSheet.flatten(screen.getByText('1:29').props.style).color).not.toBe(theme.colors.danger[600]);
  await tick(1_000);
  expect(StyleSheet.flatten(screen.getByText('1:30').props.style).color).toBe(theme.colors.danger[600]);
});

// C-61: a failed stop must not leave the UI stuck on the stop button
it('returns to the idle state when stopping fails', async () => {
  mockStopAndUnloadAsync.mockRejectedValueOnce(new Error('boom'));
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await press(screen);
  await tick(6_000);
  await press(screen); // stop fails
  expect(onComplete).not.toHaveBeenCalled();
  expect(screen.getByText('Tap to start recording')).toBeTruthy();
  expect(screen.getByText('0:00')).toBeTruthy();
});
