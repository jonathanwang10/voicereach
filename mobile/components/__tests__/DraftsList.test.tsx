// H2-7.7: recordings still on the phone or on the server, until each is reviewed or
// discarded. Only the extracted name shows, never the transcript.
const mockQueued: any[] = [];
jest.mock('../../services/recordingQueue', () => ({
  listQueued: jest.fn(async () => mockQueued.map(i => ({ ...i }))),
  subscribe: jest.fn(() => () => {}),
  removeQueued: jest.fn(async () => undefined),
  isOnlineState: jest.requireActual('../../services/recordingQueue').isOnlineState,
}));
jest.mock('../../services/api', () => ({
  api: { listRecordings: jest.fn(async () => []), deleteRecording: jest.fn(async () => undefined) },
}));

import React from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import NetInfo from '@react-native-community/netinfo';
import { DraftsList } from '../DraftsList';
import { api } from '../../services/api';
import { removeQueued } from '../../services/recordingQueue';
import { renderWithQuery } from '../../test/renderWithQuery';

const local = (id: string, state = 'pending', lastError: string | null = null) => ({
  clientRecordingId: id, fileUri: `file:///docs/recordings/${id}.m4a`, durationMs: 65000, location: null,
  createdAt: '2026-11-07T10:05:00.000Z', state, attempts: 0, nextAttemptAt: 0, lastError,
});
const server = (id: string, status: string, extra: any = {}) => ({
  id, status, error: null, name: null, duration_ms: 61000, created_at: '2026-11-07T10:00:00Z', ...extra,
});
const list = api.listRecordings as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockQueued.length = 0;
  list.mockResolvedValue([]);
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

it('lists queued and server drafts with their status', async () => {
  (NetInfo.useNetInfo as jest.Mock).mockReturnValue({ isConnected: false, isInternetReachable: false });
  mockQueued.push(local('c1'));
  list.mockResolvedValue([server('r1', 'ready', { name: 'Ann Lee' }), server('r2', 'transcribing')]);
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={jest.fn()} />);
  expect(await s.findByText('Drafts (3)')).toBeTruthy();
  expect(s.getByText('Queued: no connection')).toBeTruthy();
  expect(s.getByText('Ready to review')).toBeTruthy();
  expect(s.getByText('Transcribing')).toBeTruthy();
  expect(s.getByText('Ann Lee')).toBeTruthy();
  expect(s.getAllByText('Recording')).toHaveLength(2);   // no name yet
  expect(s.getByText('1:05')).toBeTruthy();               // the queued one's duration
  expect(s.getAllByText('1:01')).toHaveLength(2);
});

it('leaves out the recording the status card already shows', async () => {
  list.mockResolvedValue([server('r1', 'ready', { name: 'Ann Lee' }), server('r2', 'transcribing')]);
  const s = renderWithQuery(<DraftsList excludeIds={['r1']} onReview={jest.fn()} />);
  expect(await s.findByText('Drafts (1)')).toBeTruthy();
  expect(s.queryByText('Ann Lee')).toBeNull();
});

it('a ready draft opens the review', async () => {
  const onReview = jest.fn();
  list.mockResolvedValue([server('r1', 'ready', { name: 'Ann Lee' })]);
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={onReview} />);
  fireEvent.press(await s.findByText('Ann Lee'));
  expect(onReview).toHaveBeenCalledWith('r1');
});

it('a failed draft can be discarded', async () => {
  list.mockResolvedValue([server('r2', 'failed', { error: 'Processing failed. Please record again.' })]);
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={jest.fn()} />);
  expect(await s.findByText("Couldn't process this recording")).toBeTruthy();
  await act(async () => { fireEvent.press(s.getByText('Discard')); });
  expect(api.deleteRecording).toHaveBeenCalledWith('r2');
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});

it('a rejected upload can be discarded', async () => {
  mockQueued.push(local('c1', 'rejected', 'File is not in M4A format'));
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={jest.fn()} />);
  expect(await s.findByText("Couldn't upload this recording")).toBeTruthy();
  await act(async () => { fireEvent.press(s.getByText('Discard')); });
  expect(removeQueued).toHaveBeenCalledWith('c1');
});

it('renders nothing when there are no drafts', async () => {
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={jest.fn()} />);
  await waitFor(() => expect(list).toHaveBeenCalled());
  expect(s.toJSON()).toBeNull();
});

it('shows the extracted name, never the transcript', async () => {
  list.mockResolvedValue([server('r1', 'ready', { name: 'Ann Lee', transcription: 'Met Ann by the library' })]);
  const s = renderWithQuery(<DraftsList excludeIds={[]} onReview={jest.fn()} />);
  await s.findByText('Ann Lee');
  expect(s.queryByText(/library/)).toBeNull();
});
