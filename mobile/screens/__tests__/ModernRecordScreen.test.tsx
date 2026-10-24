// C-13: no second recording while one is being transcribed, and one success toast per save.
// C-02: each recording carries its own location unless one was picked by hand.
// C-04: the picker opens at the location the screen already has.
// C-38: "Try Again" re-transcribes the same recording; "Record again" discards it.
// C-65: the recording leaves the app's cache once it is saved or discarded.
import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

let mockNextFix: any;
let mockNextUri = 'file:///clip.m4a';
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
// No AuthContext mock: the screen no longer reads auth (App only mounts it signed in),
// so rendering it without an AuthProvider must work.
jest.mock('../../services/api', () => ({ api: { transcribe: jest.fn() } }));
jest.mock('expo-file-system', () => ({ deleteAsync: jest.fn().mockResolvedValue(undefined) }));
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
      <TouchableOpacity onPress={() => onRecordingComplete(mockNextUri, mockNextFix)}>
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
import * as FileSystem from 'expo-file-system';

const RESULT = {
  transcription: 't', categorized_data: {}, missing_required: [], potential_matches: [], validation_errors: [],
};
const fix = (address: string, latitude = 37.1, longitude = -122.1) => ({ location: { latitude, longitude, address } });

beforeEach(() => {
  jest.clearAllMocks();
  mockNextFix = undefined;
  mockNextUri = 'file:///clip.m4a';
  (api.transcribe as jest.Mock).mockResolvedValue(RESULT);
});

describe('H2-6.3 one Transcribing state with the real reason', () => {
  it('shows "Transcribing..." while the recording is processed', async () => {
    (api.transcribe as jest.Mock).mockReturnValue(new Promise(() => {}));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Transcribing...');
    expect(screen.queryByText('Uploading audio...')).toBeNull();
  });

  it("shows the backend's reason on the error card", async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('File is not in M4A format'), { detail: 'File is not in M4A format', status: 400 }));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('File is not in M4A format');
    expect(screen.getByText('Try Again')).toBeTruthy();
  });

  it('shows one toast per failure, not two', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('The server took too long to respond. Please try again.'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Try Again');
    const toasts = (Toast.show as jest.Mock).mock.calls.map(c => c[0]);
    expect(toasts.filter(t => t.type === 'error')).toHaveLength(1);
    expect(toasts.filter(t => t.type === 'info')).toHaveLength(0);
  });
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

  // Fix round 1 (#1): a manual save must not wipe a voice result's pending location
  it('keeps a pending voice result\'s location when a manual entry is saved', async () => {
    const screen = render(<ModernRecordScreen />);
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: First St');

    fireEvent.press(screen.getByText('Manual Entry'));
    fireEvent.press(screen.getByText('Stub Manual Save'));
    fireEvent.press(screen.getByText('Voice Recording'));
    expect(screen.getByText('Loc: First St')).toBeTruthy();
  });

  // Fix round 1 (#5): a hand-picked location belongs to one record only
  it('does not carry a hand-picked location over to the next recording', async () => {
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Loc: Picked St');
    fireEvent.press(screen.getByText('Stub Save'));

    mockNextFix = fix('Second St');
    fireEvent.press(await screen.findByText('Stub Recorder'));
    await screen.findByText('Loc: Second St');
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

  // Fix round 1 (#5): the retry keeps the recording's own location
  it('"Try Again" keeps the recording\'s location', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    fireEvent.press(await screen.findByText('Try Again'));
    await screen.findByText('Loc: First St');
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

describe('C-65 recorded audio', () => {
  it('is deleted from the cache once the record is saved', async () => {
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    fireEvent.press(await screen.findByText('Stub Save'));
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///clip.m4a', { idempotent: true });
  });

  it('is deleted when it is discarded with "Record again"', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    fireEvent.press(await screen.findByText('Record again'));
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///clip.m4a', { idempotent: true });
  });

  it('is kept while "Try Again" may still need it', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Try Again');
    expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
  });
});

describe('C-65 recorded audio: no leftovers (T14 fix round 1)', () => {
  it('recording again after a failed transcription deletes the earlier file', async () => {
    (api.transcribe as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Try Again');

    mockNextUri = 'file:///clip2.m4a';
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Stub Save');
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///clip.m4a', { idempotent: true });
    expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith('file:///clip2.m4a', expect.anything());
  });

  it('leaving the screen deletes the current recording', async () => {
    const screen = render(<ModernRecordScreen />);
    fireEvent.press(screen.getByText('Stub Recorder'));
    await screen.findByText('Stub Save');
    screen.unmount();
    expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///clip.m4a', { idempotent: true });
  });
});
