// The recording queue's table (H2-7.6), the only file that touches expo-sqlite. It
// holds the audio file's path, the location and the upload state: never a transcript
// or any other case data (the server makes those).
import * as SQLite from 'expo-sqlite';
import { LocationData } from '../types';

export type QueueState = 'pending' | 'uploading' | 'rejected';

export interface QueuedRecording {
  clientRecordingId: string;
  fileUri: string;
  durationMs: number;
  location: LocationData | null;
  createdAt: string;
  state: QueueState;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

const DDL = `CREATE TABLE IF NOT EXISTS recording_queue (
  client_recording_id TEXT PRIMARY KEY NOT NULL,
  file_uri TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  location TEXT,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);`;

const COLUMNS: Record<'state' | 'attempts' | 'nextAttemptAt' | 'lastError', string> = {
  state: 'state',
  attempts: 'attempts',
  nextAttemptAt: 'next_attempt_at',
  lastError: 'last_error',
};

let opening: Promise<SQLite.SQLiteDatabase> | null = null;

// Opened lazily, once
const database = (): Promise<SQLite.SQLiteDatabase> =>
  opening ?? (opening = (async () => {
    const db = await SQLite.openDatabaseAsync('recording-queue.db');
    await db.execAsync(DDL);
    return db;
  })());

type Row = {
  client_recording_id: string; file_uri: string; duration_ms: number; location: string | null;
  created_at: string; state: QueueState; attempts: number; next_attempt_at: number; last_error: string | null;
};

const fromRow = (r: Row): QueuedRecording => ({
  clientRecordingId: r.client_recording_id,
  fileUri: r.file_uri,
  durationMs: r.duration_ms,
  location: r.location ? JSON.parse(r.location) : null,
  createdAt: r.created_at,
  state: r.state,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
});

export async function insertQueued(item: QueuedRecording): Promise<void> {
  const db = await database();
  await db.runAsync(
    'INSERT INTO recording_queue (client_recording_id, file_uri, duration_ms, location, created_at, state, ' +
      'attempts, next_attempt_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [item.clientRecordingId, item.fileUri, item.durationMs, item.location ? JSON.stringify(item.location) : null,
     item.createdAt, item.state, item.attempts, item.nextAttemptAt, item.lastError],
  );
}

export async function updateQueued(
  id: string,
  patch: Partial<Pick<QueuedRecording, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError'>>,
): Promise<void> {
  const keys = (Object.keys(patch) as (keyof typeof COLUMNS)[]).filter(k => k in COLUMNS);
  if (!keys.length) return;
  const db = await database();
  await db.runAsync(
    `UPDATE recording_queue SET ${keys.map(k => `${COLUMNS[k]} = ?`).join(', ')} WHERE client_recording_id = ?`,
    [...keys.map(k => patch[k] ?? null), id],
  );
}

export async function deleteQueued(id: string): Promise<void> {
  const db = await database();
  await db.runAsync('DELETE FROM recording_queue WHERE client_recording_id = ?', [id]);
}

// Oldest first
export async function allQueued(): Promise<QueuedRecording[]> {
  const db = await database();
  return (await db.getAllAsync<Row>('SELECT * FROM recording_queue ORDER BY created_at')).map(fromRow);
}

// The app was killed mid-upload: those items go back to pending
export async function resetUploading(): Promise<number> {
  const db = await database();
  return (await db.runAsync("UPDATE recording_queue SET state = 'pending' WHERE state = 'uploading'")).changes;
}

export function __resetQueueStoreForTests(): void {
  opening = null;
}
