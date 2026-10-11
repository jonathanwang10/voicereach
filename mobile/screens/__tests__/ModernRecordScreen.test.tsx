// C-13: no second recording while one is being transcribed, and one success toast per save.
// C-02: each recording carries its own location unless one was picked by hand.
// C-04: the picker opens at the location the screen already has.
// C-38: "Try Again" re-transcribes the same recording; "Record again" discards it.
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

let mockNextFix: any;
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, loading: false }) }));
jest.mock('../../services/supabase', () => ({ supabase: {} }));
jest.mock('../../services/api', () => ({ api: { transcribe: jest.fn() } }));
jest.mock('../../components/LocationPicker', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    LocationPicker: ({ onLocationSelected, initialLocation }: any) => (
      <View>
        <Text>
          Picker initial: {initialLocation ? `${initialLocation.latitude},${initialLocation.longitude}` : 'none'}
        </Text>
        <TouchableOpacity
          onPress={() => onLocationSelected({ location: { latitude: 1, longitude: 2, address: 'Picked St' } })}
        >
          <Text>Stub Pick</Text>
        </TouchableOpacity>
      </View>
    ),
  };
});
jest.mock('../../components/ModernAudioRecorder', () => {
  const React = require('react');
  const { Text, TouchableOpacity } = require('react-native');
  return {
    ModernAudioRecorder: React.forwardRef(({ onRecordingComplete }: any, _ref: any) => (
      <TouchableOpacity onPress={() => onRecordingComplete('file:///clip.m4a', mockNextFix)}>
        <Text>Stub Recorder</Text>
      </TouchableOpacity>
    )),
  };
});
jest.mock('../../components/TranscriptionResults', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    TranscriptionResults: ({ onSave, location }: any) => (
      <View>
        <Text>Loc: {location?.address ?? 'none'}</Text>
        <TouchableOpacity onPress={() => onSave({ name: 'Ann' })}>
          <Text>Stub Save</Text>
        </TouchableOpacity>
      </View>
    ),
  };
});
jest.mock('../../components/ManualEntryForm', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    ManualEntryForm: ({ onSave, selectedLocation }: any) => (
      <View>
        <Text>Manual loc: {selectedLocation?.address ?? 'none'}</Text>
        <TouchableOpacity onPress={() => onSave({ name: 'Ann' })}>
          <Text>Stub Manual Save</Text>
        </TouchableOpacity>
      </View>
    ),
  };
});

import Toast from 'react-native-toast-message';
import { ModernRecordScreen } from '../ModernRecordScreen';
import { api } from '../../services/api';

const RESULT = {
  transcription: 't', categorized_data: {}, missing_required: [], potential_matches: [], validation_errors: [],
};
const fix = (address: string, latitude = 37.1, longitude = -122.1) => ({ location: { latitude, longitude, address } });

beforeEach(() => {
  jest.clearAllMocks();
  mockNextFix = undefined;
  (api.transcribe as jest.Mock).mockResolvedValue(RESULT);
});

it('hides the recorder while a recording is being transcribed', async () => {
  let finish: (r: any) => void = () => {};
  (api.transcribe as jest.Mock).mockReturnValue(new Promise(r => { finish = r; }));
  const { getByText, queryByText, findByText } = render(<ModernRecordScreen />);

  fireEvent.press(getByText('Stub Recorder'));
  await waitFor(() => expect(api.transcribe).toHaveBeenCalled());
  expect(queryByText('Stub Recorder')).toBeNull();

  await act(async () => finish(RESULT));
  await findByText('Stub Save');
});

it('leaves the save toast to the form: the screen adds none', async () => {
  const { getByText, findByText } = render(<ModernRecordScreen />);
  fireEvent.press(getByText('Stub Recorder'));
  fireEvent.press(await findByText('Stub Save'));

  const saveToasts = (Toast.show as jest.Mock).mock.calls
    .map(c => c[0])
    .filter(t => t.type === 'success' && /saved|recorded/i.test(t.text2 ?? ''));
  expect(saveToasts).toEqual([]);
  // and the screen is back to a fresh recorder
  await findByText('Stub Recorder');
});

describe('location (C-02, C-04)', () => {
  it("stamps each recording with its own fix, not the first one's", async () => {
    const screen = render(<ModernRecordScreen />);
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: First St');
    fireEvent.press(screen.getByText('Stub Save'));

    mockNextFix = fix('Second St');
    fireEvent.press(await screen.findByText('Stub Recorder'));
    await screen.findByText('Loc: Second St');
  });

  it('does not reuse the previous fix when a recording has none', async () => {
    const screen = render(<ModernRecordScreen />);
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: First St');
    fireEvent.press(screen.getByText('Stub Save'));

    mockNextFix = undefined;
    fireEvent.press(await screen.findByText('Stub Recorder'));
    await screen.findByText('Loc: none');
    expect(screen.queryByText('Location Set')).toBeNull();
  });

  it("uses a hand-picked location over the recording's fix", async () => {
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));

    mockNextFix = fix('Gps St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: Picked St');
  });

  it('opens the picker at the current location', async () => {
    const screen = render(<ModernRecordScreen />);
    mockNextFix = fix('Gps St', 37.5, -122.5);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: Gps St');

    fireEvent.press(screen.getByText('Change location'));
    expect(screen.getByText('Picker initial: 37.5,-122.5')).toBeTruthy();
  });

  it('clears the location after a manual save', async () => {
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    fireEvent.press(screen.getByText('Manual Entry'));
    expect(screen.getByText('Manual loc: Picked St')).toBeTruthy();

    fireEvent.press(screen.getByText('Stub Manual Save'));
    expect(screen.getByText('Manual loc: none')).toBeTruthy();
  });
});

describe('after a failed transcription (C-38)', () => {
  it('"Try Again" re-transcribes the same recording', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    fireEvent.press(await screen.findByText('Try Again'));

    await screen.findByText('Stub Save');
    expect(api.transcribe).toHaveBeenCalledTimes(2);
    expect((api.transcribe as jest.Mock).mock.calls[1][0]).toBe('file:///clip.m4a');
  });

  it('"Record again" discards the recording', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    fireEvent.press(await screen.findByText('Record again'));

    expect(screen.queryByText('Try Again')).toBeNull();
    expect(screen.getByText('Stub Recorder')).toBeTruthy();
    expect(api.transcribe).toHaveBeenCalledTimes(1);
  });
});
