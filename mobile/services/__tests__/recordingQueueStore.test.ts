// H2-7.6: the queue's SQLite table holds audio paths, location and upload state only.
import * as SQLite from 'expo-sqlite';
import {
  allQueued, deleteQueued, insertQueued, QueuedRecording, resetUploading, updateQueued, __resetQueueStoreForTests,
} from '../recordingQueueStore';

const db = (SQLite as any).__db;
const LOC = { latitude: 37.78, longitude: -122.41, address: 'Market St' };
const ITEM: QueuedRecording = {
  clientRecordingId: 'c1', fileUri: 'file:///docs/recordings/c1.m4a', durationMs: 61000, location: LOC,
  createdAt: '2026-11-07T10:00:00.000Z', state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetQueueStoreForTests();
});

it('creates the table with only audio, location and upload-state columns', async () => {
  await allQueued();
  const ddl = (db.execAsync as jest.Mock).mock.calls.map(c => c[0]).join('\n');
  const cols = [...ddl.matchAll(/^\s*(\w+) (TEXT|INTEGER)/gm)].map(m => m[1]);
  expect(cols).toEqual(['client_recording_id', 'file_uri', 'duration_ms', 'location', 'created_at', 'state',
                        'attempts', 'next_attempt_at', 'last_error']);
});

it('opens the database once', async () => {
  await allQueued();
  await allQueued();
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('recording-queue.db');
});

it('inserts with bound parameters and the location as JSON', async () => {
  await insertQueued(ITEM);
  const [sql, params] = (db.runAsync as jest.Mock).mock.calls[0];
  expect(sql).toMatch(/^INSERT INTO recording_queue/);
  expect(sql).not.toContain('Market St');
  expect(params).toEqual(['c1', 'file:///docs/recordings/c1.m4a', 61000, JSON.stringify(LOC),
                          '2026-11-07T10:00:00.000Z', 'pending', 0, 0, null]);
});

it('stores no location as NULL', async () => {
  await insertQueued({ ...ITEM, location: null });
  expect((db.runAsync as jest.Mock).mock.calls[0][1][3]).toBeNull();
});

it('maps rows back to QueuedRecording, parsing location', async () => {
  (db.getAllAsync as jest.Mock).mockResolvedValueOnce([{
    client_recording_id: 'c1', file_uri: 'file:///docs/recordings/c1.m4a', duration_ms: 61000,
    location: JSON.stringify(LOC), created_at: '2026-11-07T10:00:00.000Z', state: 'pending', attempts: 2,
    next_attempt_at: 5000, last_error: 'offline',
  }]);
  expect(await allQueued()).toEqual([{ ...ITEM, attempts: 2, nextAttemptAt: 5000, lastError: 'offline' }]);
  expect((db.getAllAsync as jest.Mock).mock.calls[0][0]).toMatch(/ORDER BY created_at/);
});

it('updates only the given fields, with bound parameters', async () => {
  await updateQueued('c1', { state: 'rejected', lastError: 'File is not in M4A format' });
  const [sql, params] = (db.runAsync as jest.Mock).mock.calls[0];
  expect(sql).toBe('UPDATE recording_queue SET state = ?, last_error = ? WHERE client_recording_id = ?');
  expect(params).toEqual(['rejected', 'File is not in M4A format', 'c1']);
});

it('deletes by id', async () => {
  await deleteQueued('c1');
  expect((db.runAsync as jest.Mock).mock.calls[0]).toEqual(['DELETE FROM recording_queue WHERE client_recording_id = ?', ['c1']]);
});

it('resetUploading moves uploading rows back to pending', async () => {
  (db.runAsync as jest.Mock).mockResolvedValueOnce({ changes: 2, lastInsertRowId: 0 });
  expect(await resetUploading()).toBe(2);
  expect((db.runAsync as jest.Mock).mock.calls[0][0]).toBe(
    "UPDATE recording_queue SET state = 'pending' WHERE state = 'uploading'");
});
