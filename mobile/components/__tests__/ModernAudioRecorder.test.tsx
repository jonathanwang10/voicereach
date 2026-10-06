import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

const mockStopAndUnloadAsync = jest.fn(async () => {});
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    setAudioModeAsync: jest.fn(async () => {}),
    Recording: { createAsync: jest.fn(async () => ({ recording: { stopAndUnloadAsync: mockStopAndUnloadAsync, getURI: () => 'file://a.m4a' } })) },
    RecordingOptionsPresets: { LOW_QUALITY: { android: {}, ios: {}, web: {} } },
    AndroidOutputFormat: { MPEG_4: 2 }, AndroidAudioEncoder: { AAC: 3 },
  },
}));
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  Accuracy: { High: 4 },
}));

import { ModernAudioRecorder } from '../ModernAudioRecorder';

it('auto-stops at 2:00 and reports the recording', async () => {
  jest.useFakeTimers();
  const onComplete = jest.fn();
  const screen = render(<ModernAudioRecorder onRecordingComplete={onComplete} />);
  await act(async () => { fireEvent.press(screen.getByTestId('record-button')); });
  await act(async () => { jest.advanceTimersByTime(121_000); });
  expect(mockStopAndUnloadAsync).toHaveBeenCalled();
  expect(onComplete).toHaveBeenCalledWith('file://a.m4a', undefined);
  jest.useRealTimers();
});
