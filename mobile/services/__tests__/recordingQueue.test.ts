// H2-7.6: a finished recording waits on the phone and uploads in the background once
// there is a connection, with backoff; nothing is left behind after a 202.
const mockRows: any[] = [];
jest.mock('../recordingQueueStore', () => ({
  insertQueued: jest.fn(async (item: any) => { mockRows.push({ ...item }); }),
  updateQueued: jest.fn(async (id: string, patch: any) => {
    const row = mockRows.find(r => r.clientRecordingId === id);
    if (row) Object.assign(row, patch);
  }),
  deleteQueued: jest.fn(async (id: string) => {
    const i = mockRows.findIndex(r => r.clientRecordingId === id);
    if (i >= 0) mockRows.splice(i, 1);
  }),
  allQueued: jest.fn(async () => mockRows.map(r => ({ ...r })).sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
  resetUploading: jest.fn(async () => {
    let n = 0;
    mockRows.forEach(r => { if (r.state === 'uploading') { r.state = 'pending'; n++; } });
    return n;
  }),
}));
jest.mock('expo-file-system', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(async () => undefined),
  moveAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('../api', () => {
  const actual = jest.requireActual('../api');
  return { ApiError: actual.ApiError, api: { uploadRecording: jest.fn() } };
});
let mockIds = 0;
jest.mock('../../utils/requestId', () => ({ newRequestId: () => `c${++mockIds}` }));

import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import { api, ApiError } from '../api';
import {
  BACKOFF_MS, enqueueRecording, flushQueue, isOnlineState, listQueued, removeQueued, startRecordingQueue,
  subscribe, __resetRecordingQueueForTests,
} from '../recordingQueue';

const LOC = { latitude: 37.78, longitude: -122.41, address: 'Market St' };
const upload = api.uploadRecording as jest.Mock;
const online = { isConnected: true, isInternetReachable: true };
const offline = { isConnected: false, isInternetReachable: false };
let netListener: (s: any) => void = () => {};
let appListener: (s: string) => void = () => {};
const netUnsubscribe = jest.fn();
const appRemove = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockRows.length = 0;
  mockIds = 0;
  __resetRecordingQueueForTests();
  (NetInfo.fetch as jest.Mock).mockResolvedValue(online);
  (NetInfo.addEventListener as jest.Mock).mockImplementation((l: any) => { netListener = l; return netUnsubscribe; });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, l: any) => {
    appListener = l;
    return { remove: appRemove };
  }) as any);
  upload.mockResolvedValue({ id: 'r1', status: 'queued' });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const states = () => mockRows.map(r => r.state);

it('moves the recording into documentDirectory/recordings and queues it without uploading yet', async () => {
  const listener = jest.fn();
  subscribe(listener);
  const item = await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  expect(FileSystem.makeDirectoryAsync).toHaveBeenCalledWith('file:///docs/recordings/', { intermediates: true });
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/rec.m4a', to: 'file:///docs/recordings/c1.m4a' });
  expect(item).toMatchObject({ clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a', durationMs: 61000,
                               state: 'pending', attempts: 0, location: LOC, lastError: null });
  expect(api.uploadRecording).not.toHaveBeenCalled();
  expect(listener).toHaveBeenCalledWith({ type: 'changed' });
});

it('does not upload while offline', async () => {
  (NetInfo.fetch as jest.Mock).mockResolvedValue(offline);
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  await flushQueue();
  expect(upload).not.toHaveBeenCalled();
  expect(states()).toEqual(['pending']);
});

it("a 202 deletes the queued file, Expo's multipart copy and the row", async () => {
  const listener = jest.fn();
  subscribe(listener);
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  await flushQueue();
  expect(upload).toHaveBeenCalledWith({ clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a',
                                        durationMs: 61000, location: LOC });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///docs/recordings/c1.m4a', { idempotent: true });
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/uploads/c1.m4a', { idempotent: true });
  expect(await listQueued()).toEqual([]);
  expect(listener).toHaveBeenCalledWith({ type: 'uploaded', clientRecordingId: 'c1', recordingId: 'r1' });
});

it('uploads oldest first, one at a time', async () => {
  jest.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  await enqueueRecording('file:///cache/a.m4a', 6000, null);
  jest.setSystemTime(new Date('2026-11-07T10:00:01Z'));
  await enqueueRecording('file:///cache/b.m4a', 6000, null);
  upload.mockResolvedValueOnce({ id: 'r1', status: 'queued' }).mockResolvedValueOnce({ id: 'r2', status: 'queued' });
  await flushQueue();
  expect(upload.mock.calls.map(c => c[0].clientRecordingId)).toEqual(['c1', 'c2']);
});

it('a network failure backs off 5 s, then retries', async () => {
  upload.mockRejectedValueOnce(new ApiError(0, 'No connection to the server.', 'network'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const now = Date.now();
  await flushQueue();
  expect(mockRows[0]).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: now + 5000,
                                      lastError: 'No connection to the server.' });
  await jest.advanceTimersByTimeAsync(4999);
  expect(upload).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(upload).toHaveBeenCalledTimes(2);
  expect(mockRows).toEqual([]);
});

it('backs off 5 s, 30 s, 120 s, then every 600 s', async () => {
  expect(BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
  upload.mockRejectedValue(new ApiError(503, 'Service unavailable', 'http'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const gaps: number[] = [];
  let last = Date.now();
  await flushQueue();
  for (let i = 0; i < 5; i++) {
    gaps.push(mockRows[0].nextAttemptAt - last);
    last = mockRows[0].nextAttemptAt;
    await jest.advanceTimersByTimeAsync(mockRows[0].nextAttemptAt - Date.now());
  }
  expect(gaps).toEqual([5_000, 30_000, 120_000, 600_000, 600_000]);
});

it.each([[408], [429], [500]])('a %s is retried', async (status) => {
  upload.mockRejectedValueOnce(new ApiError(status, 'busy', 'http'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  await flushQueue();
  expect(mockRows[0]).toMatchObject({ state: 'pending', attempts: 1 });
});

it('a 400 rejects the item with the server detail and never retries it', async () => {
  upload.mockRejectedValue(new ApiError(400, 'File is not in M4A format', 'http'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  await flushQueue();
  expect(mockRows[0]).toMatchObject({ state: 'rejected', lastError: 'File is not in M4A format' });
  await jest.advanceTimersByTimeAsync(3_600_000);
  await flushQueue();
  expect(upload).toHaveBeenCalledTimes(1);
});

it('two flushes at once upload each item once', async () => {
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  await Promise.all([flushQueue(), flushQueue()]);
  expect(upload).toHaveBeenCalledTimes(1);
});

it('start resets items left uploading and uploads them', async () => {
  mockRows.push({ clientRecordingId: 'c9', fileUri: 'file:///docs/recordings/c9.m4a', durationMs: 6000, location: null,
                  createdAt: '2026-11-07T10:00:00.000Z', state: 'uploading', attempts: 0, nextAttemptAt: 0, lastError: null });
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({ clientRecordingId: 'c9' }));
  expect(mockRows).toEqual([]);
  stop();
});

it('uploads when the connection comes back', async () => {
  (NetInfo.fetch as jest.Mock).mockResolvedValue(offline);
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).not.toHaveBeenCalled();
  (NetInfo.fetch as jest.Mock).mockResolvedValue(online);
  netListener(online);
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledTimes(1);
  stop();
});

it('uploads when the app returns to the foreground', async () => {
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  appListener('active');
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledTimes(1);
  stop();
});

it('stop removes the listeners and the retry timer', async () => {
  upload.mockRejectedValueOnce(new ApiError(0, 'offline', 'network'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledTimes(1);
  stop();
  expect(netUnsubscribe).toHaveBeenCalled();
  expect(appRemove).toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(upload).toHaveBeenCalledTimes(1);
});

it('a flush still running when stop is called arms no retry afterwards', async () => {   // review M-6
  let fail: (e: unknown) => void = () => {};
  upload.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  expect(upload).toHaveBeenCalledTimes(1);      // the upload is in flight
  stop();                                       // e.g. sign-out
  fail(new ApiError(0, 'offline', 'network'));
  await jest.advanceTimersByTimeAsync(0);
  expect(mockRows[0]).toMatchObject({ state: 'pending', attempts: 1 });
  await jest.advanceTimersByTimeAsync(3_600_000);
  expect(upload).toHaveBeenCalledTimes(1);
});

it('start after a stop arms retries again', async () => {
  startRecordingQueue()();
  upload.mockRejectedValueOnce(new ApiError(0, 'offline', 'network'));
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  const stop = startRecordingQueue();
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(5000);
  expect(upload).toHaveBeenCalledTimes(2);
  stop();
});

it('removeQueued deletes the file and the row', async () => {
  const listener = jest.fn();
  await enqueueRecording('file:///cache/rec.m4a', 61000, LOC);
  subscribe(listener);
  await removeQueued('c1');
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///docs/recordings/c1.m4a', { idempotent: true });
  expect(await listQueued()).toEqual([]);
  expect(listener).toHaveBeenCalledWith({ type: 'changed' });
});

it('treats unknown reachability as online', () => {
  expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
  expect(isOnlineState({ isConnected: false, isInternetReachable: null })).toBe(false);
  expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
});
