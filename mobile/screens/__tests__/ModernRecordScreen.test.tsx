// H2-7.7: a finished recording is queued, uploaded in the background and reviewed as a
// draft once the server has processed it.
// C-02: each recording carries its own location unless one was picked by hand.
// C-04: the picker opens at the location the screen already has.
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, waitFor, act } from '@testing-library/react-native';

let mockNextFix: any;
// Every queue subscriber (the screen and useQueuedRecordings) hears each event
const mockQueueListeners = new Set<(e: any) => void>();
const mockQueueListener = (e: any) => mockQueueListeners.forEach(l => l(e));
const mockQueued: any[] = [];
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../services/recordingQueue', () => ({
  enqueueRecording: jest.fn(async (fileUri: string, durationMs: number, location: any) => {
    const item = { clientRecordingId: `c${mockQueued.length + 1}`, fileUri, durationMs, location,
                   createdAt: '2026-11-07T10:00:00.000Z', state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null };
    mockQueued.push(item);
    return item;
  }),
  flushQueue: jest.fn(async () => undefined),
  subscribe: jest.fn((listener: any) => {
    mockQueueListeners.add(listener);
    return () => { mockQueueListeners.delete(listener); };
  }),
  listQueued: jest.fn(async () => mockQueued.map(i => ({ ...i }))),
  removeQueued: jest.fn(async () => undefined),
  isOnlineState: jest.requireActual('../../services/recordingQueue').isOnlineState,
}));
jest.mock('../../services/api', () => ({
  api: { getRecording: jest.fn(), deleteRecording: jest.fn(async () => undefined), listRecordings: jest.fn(async () => []) },
}));
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
      <TouchableOpacity onPress={() => onRecordingComplete('file:///clip.m4a', mockNextFix, 61000)}>
        <Text>Stub Recorder</Text>
      </TouchableOpacity>
    )),
  };
});
jest.mock('../../components/TranscriptionResults', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    TranscriptionResults: ({ onSave, onCancel, location, idempotencyKey, recheckDuplicates, result }: any) => (
      <View>
        <Text>Draft: {result.transcription}</Text>
        <Text>Loc: {location?.address ?? 'none'}</Text>
        <Text>Key: {idempotencyKey ?? 'none'}</Text>
        <Text>Recheck: {recheckDuplicates ? 'yes' : 'no'}</Text>
        <TouchableOpacity onPress={() => onSave({ name: 'Ann' })}><Text>Stub Save</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => onCancel()}><Text>Stub Cancel</Text></TouchableOpacity>
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
import NetInfo from '@react-native-community/netinfo';
import { ModernRecordScreen } from '../ModernRecordScreen';
import { api } from '../../services/api';
import { enqueueRecording, flushQueue, removeQueued } from '../../services/recordingQueue';
import { renderWithQuery } from '../../test/renderWithQuery';

const RESULT = {
  transcription: 'Met Ann', categorized_data: { name: 'Ann' }, missing_required: [], potential_matches: [],
  validation_errors: [],
};
const fix = (address: string, latitude = 37.1, longitude = -122.1) => ({ location: { latitude, longitude, address } });
const detail = (status: string, extra: any = {}) => ({
  id: 'r1', status, error: null, result: status === 'ready' ? RESULT : null, location: null,
  duration_ms: 61000, created_at: '2026-11-07T10:00:00Z', ...extra,
});
const ONLINE = { isConnected: true, isInternetReachable: true };

const render = () => renderWithQuery(<ModernRecordScreen />);

// Record, then let the queue report the upload's 202
async function recordAndUpload(screen: any, recordingId = 'r1') {
  fireEvent.press(screen.getByText('Stub Recorder'));
  await waitFor(() => expect(flushQueue).toHaveBeenCalled());
  const item = mockQueued[mockQueued.length - 1];
  await act(async () => {
    mockQueued.splice(mockQueued.indexOf(item), 1);
    mockQueueListener({ type: 'uploaded', clientRecordingId: item.clientRecordingId, recordingId });
    mockQueueListener({ type: 'changed' });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNextFix = undefined;
  mockQueued.length = 0;
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue(ONLINE);
  (api.getRecording as jest.Mock).mockResolvedValue(detail('ready'));
});

describe('queueing (H2-7.6)', () => {
  it('queues the recording with its own fix, then starts the upload', async () => {
    mockNextFix = fix('First St');
    const screen = render();
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(flushQueue).toHaveBeenCalled());
    expect(enqueueRecording).toHaveBeenCalledWith('file:///clip.m4a', 61000, fix('First St').location);
    expect((enqueueRecording as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((flushQueue as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('shows the recorder again as soon as a recording is queued', async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalled());
    expect(screen.getByText('Stub Recorder')).toBeTruthy();
  });

  it('shows "Queued: no connection" while offline', async () => {
    (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
    const screen = render();
    fireEvent.press(screen.getByText('Stub Recorder'));
    expect(await screen.findByText('Queued: no connection')).toBeTruthy();
  });

  it('shows "Uploading" while the queued recording is sent', async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Stub Recorder'));
    expect(await screen.findByText('Uploading')).toBeTruthy();
  });

  it("a rejected upload shows the server's reason and can be discarded", async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(flushQueue).toHaveBeenCalled());
    await act(async () => {
      Object.assign(mockQueued[0], { state: 'rejected', lastError: 'File is not in M4A format' });
      mockQueueListener({ type: 'changed' });
    });
    expect(await screen.findByText("Couldn't upload this recording")).toBeTruthy();
    expect(screen.getByText('File is not in M4A format')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Discard')); });
    expect(removeQueued).toHaveBeenCalledWith('c1');
  });
});

describe('processing and review (H2-7.7)', () => {
  it('polls the recording every 2 s while it is transcribing', async () => {
    (api.getRecording as jest.Mock).mockResolvedValue(detail('transcribing'));
    jest.useFakeTimers();
    try {
      const screen = render();
      await recordAndUpload(screen);
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Transcribing')).toBeTruthy();
      expect(api.getRecording).toHaveBeenCalledTimes(1);
      await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
      expect(api.getRecording).toHaveBeenCalledTimes(2);
      expect(api.getRecording).toHaveBeenLastCalledWith('r1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows "Ready to review" and stops polling once ready', async () => {
    jest.useFakeTimers();
    try {
      const screen = render();
      await recordAndUpload(screen);
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Ready to review')).toBeTruthy();
      await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
      expect(api.getRecording).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('Review now opens the stored result with the recording location', async () => {
    (api.getRecording as jest.Mock).mockResolvedValue(detail('ready', { location: fix('Gps St').location }));
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    expect(screen.getByText('Draft: Met Ann')).toBeTruthy();
    expect(screen.getByText('Loc: Gps St')).toBeTruthy();
    expect(screen.getByText('Recheck: yes')).toBeTruthy();
    expect(screen.queryByText('Stub Recorder')).toBeNull();
  });

  it('saving a draft passes its recording id as the idempotency key and deletes the recording', async () => {
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    expect(screen.getByText('Key: r1')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Stub Save')); });
    expect(api.deleteRecording).toHaveBeenCalledWith('r1');
    expect(await screen.findByText('Stub Recorder')).toBeTruthy();
    expect(screen.queryByText('Ready to review')).toBeNull();
  });

  it("a draft saved but not deleted says so, and leaves it in Drafts", async () => {
    (api.deleteRecording as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    await act(async () => { fireEvent.press(screen.getByText('Stub Save')); });
    expect((Toast.show as jest.Mock).mock.calls.map(c => c[0].text1)).toContain("Saved. Couldn't remove the draft.");
    expect(await screen.findByText('Stub Recorder')).toBeTruthy();
  });

  it('Later keeps the recording for Drafts without deleting it', async () => {
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Later'));
    expect(screen.queryByText('Ready to review')).toBeNull();
    expect(api.deleteRecording).not.toHaveBeenCalled();
  });

  it('discarding asks first, then deletes the recording', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    fireEvent.press(screen.getByText('Stub Cancel'));
    expect(alert).toHaveBeenCalledWith('Discard this recording?', 'The audio and its transcript will be deleted.',
      expect.any(Array));
    expect(api.deleteRecording).not.toHaveBeenCalled();
    const discard = alert.mock.calls[0][2]!.find(b => b.text === 'Discard')!;
    await act(async () => { discard.onPress!(); });
    expect(api.deleteRecording).toHaveBeenCalledWith('r1');
    expect(await screen.findByText('Stub Recorder')).toBeTruthy();
    alert.mockRestore();
  });

  it('a failed recording shows its error and can be discarded', async () => {
    (api.getRecording as jest.Mock).mockResolvedValue(
      detail('failed', { error: 'Audio must be at least 5 seconds long' }));
    const screen = render();
    await recordAndUpload(screen);
    expect(await screen.findByText("Couldn't process this recording")).toBeTruthy();
    expect(screen.getByText('Audio must be at least 5 seconds long')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Discard')); });
    expect(api.deleteRecording).toHaveBeenCalledWith('r1');
  });
});

describe('location (C-02, C-04)', () => {
  it("does not reuse the previous recording's fix", async () => {
    const screen = render();
    mockNextFix = fix('First St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalledTimes(1));
    mockNextFix = undefined;
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalledTimes(2));
    expect((enqueueRecording as jest.Mock).mock.calls[1][2]).toBeNull();
  });

  it("uses a hand-picked location over the recording's fix", async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    mockNextFix = fix('Gps St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalled());
    expect((enqueueRecording as jest.Mock).mock.calls[0][2]).toEqual({ latitude: 1, longitude: 2, address: 'Picked St' });
  });

  it('does not carry a hand-picked location over to the next recording', async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalledTimes(1));
    mockNextFix = fix('Second St');
    fireEvent.press(screen.getByText('Stub Recorder'));
    await waitFor(() => expect(enqueueRecording).toHaveBeenCalledTimes(2));
    expect((enqueueRecording as jest.Mock).mock.calls[1][2]).toEqual(fix('Second St').location);
    expect(screen.queryByText('Location Set')).toBeNull();
  });

  it('opens the picker at the current location', async () => {
    (api.getRecording as jest.Mock).mockResolvedValue(detail('ready', { location: fix('Gps St', 37.5, -122.5).location }));
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    fireEvent.press(screen.getByText('Change location'));
    expect(screen.getByText('Picker initial: 37.5,-122.5')).toBeTruthy();
  });

  it('a location picked during a review is the one the review saves with', async () => {
    (api.getRecording as jest.Mock).mockResolvedValue(detail('ready', { location: fix('Gps St').location }));
    const screen = render();
    await recordAndUpload(screen);
    fireEvent.press(await screen.findByText('Review now'));
    fireEvent.press(screen.getByText('Change location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    expect(screen.getByText('Loc: Picked St')).toBeTruthy();
  });

  it('clears the location after a manual save', async () => {
    const screen = render();
    fireEvent.press(screen.getByText('Set Location'));
    fireEvent.press(screen.getByText('Stub Pick'));
    fireEvent.press(screen.getByText('Manual Entry'));
    expect(screen.getByText('Manual loc: Picked St')).toBeTruthy();
    fireEvent.press(screen.getByText('Stub Manual Save'));
    expect(screen.getByText('Manual loc: none')).toBeTruthy();
  });
});
