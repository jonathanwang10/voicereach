// The offline recording queue (H2-7.6). A finished recording is moved into the app's
// documents, listed in SQLite (recordingQueueStore) and uploaded in the background
// whenever there is a connection: at start, when the network comes back, when the app
// returns to the foreground, and on a backoff timer after a failure. A dead connection
// never loses a note. The server's client_recording_id makes a repeated upload safe.
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import { api, ApiError } from './api';
import { newRequestId } from '../utils/requestId';
import { LocationData } from '../types';
import {
  allQueued, deleteQueued, insertQueued, QueuedRecording, resetUploading, updateQueued,
} from './recordingQueueStore';

// documentDirectory, not the cache: the OS may clear the cache, and a queued note must
// survive until it is uploaded
export const RECORDINGS_DIR = `${FileSystem.documentDirectory}recordings/`;
// Where expo-file-system writes its multipart copy of an upload (nothing else deletes it)
export const UPLOAD_COPY_DIR = `${FileSystem.cacheDirectory}uploads/`;
export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];

export type QueueEvent =
  | { type: 'changed' }
  | { type: 'uploaded'; clientRecordingId: string; recordingId: string };

const listeners = new Set<(e: QueueEvent) => void>();
let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Set by the stop function (sign-out): a flush still running then must not re-arm
let stopped = false;

const emit = (e: QueueEvent) => listeners.forEach(listener => listener(e));

const fileFor = (id: string) => `${RECORDINGS_DIR}${id}.m4a`;

// Unknown reachability (null) counts as online: the upload itself will tell
export function isOnlineState(s: { isConnected: boolean | null; isInternetReachable?: boolean | null }): boolean {
  return s.isConnected !== false && s.isInternetReachable !== false;
}

export function subscribe(listener: (e: QueueEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Queue a finished recording. The caller flushes once it has recorded the id.
export async function enqueueRecording(
  sourceUri: string, durationMs: number, location: LocationData | null,
): Promise<QueuedRecording> {
  const clientRecordingId = newRequestId();
  await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });
  const fileUri = fileFor(clientRecordingId);
  await FileSystem.moveAsync({ from: sourceUri, to: fileUri });
  const item: QueuedRecording = {
    clientRecordingId, fileUri, durationMs, location, createdAt: new Date().toISOString(),
    state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null,
  };
  await insertQueued(item);
  emit({ type: 'changed' });
  return item;
}

export const listQueued = (): Promise<QueuedRecording[]> => allQueued();

// Discarded before it was uploaded
export async function removeQueued(clientRecordingId: string): Promise<void> {
  await FileSystem.deleteAsync(fileFor(clientRecordingId), { idempotent: true }).catch(() => {});
  await deleteQueued(clientRecordingId);
  emit({ type: 'changed' });
}

// Worth retrying: no connection, a timeout, rate limited, a server error, or a session
// that couldn't be renewed. Any other 4xx is the file's fault and never retried.
const isTransient = (e: unknown): boolean =>
  !(e instanceof ApiError) ||
  e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500 || e.kind === 'auth';

const errorText = (e: unknown): string =>
  e instanceof ApiError ? e.detail : 'Upload failed';

async function uploadOne(item: QueuedRecording): Promise<void> {
  await updateQueued(item.clientRecordingId, { state: 'uploading' });
  try {
    const { id } = await api.uploadRecording({
      clientRecordingId: item.clientRecordingId, fileUri: item.fileUri,
      durationMs: item.durationMs, location: item.location,
    });
    // No audio stays on the phone after a 202
    await FileSystem.deleteAsync(item.fileUri, { idempotent: true }).catch(() => {});
    await FileSystem.deleteAsync(`${UPLOAD_COPY_DIR}${item.clientRecordingId}.m4a`, { idempotent: true }).catch(() => {});
    await deleteQueued(item.clientRecordingId);
    emit({ type: 'uploaded', clientRecordingId: item.clientRecordingId, recordingId: id });
  } catch (e) {
    if (__DEV__) console.warn('Recording upload failed:', e);
    if (isTransient(e)) {
      const wait = BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)];
      await updateQueued(item.clientRecordingId, {
        state: 'pending', attempts: item.attempts + 1, nextAttemptAt: Date.now() + wait, lastError: errorText(e),
      });
    } else {
      await updateQueued(item.clientRecordingId, { state: 'rejected', lastError: errorText(e) });
    }
  }
  emit({ type: 'changed' });
}

// One timer, for the earliest item waiting out its backoff
async function armRetry(): Promise<void> {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const waiting = (await allQueued()).filter(i => i.state === 'pending' && i.nextAttemptAt > Date.now());
  if (stopped || !waiting.length) return;
  const at = Math.min(...waiting.map(i => i.nextAttemptAt));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushQueue();
  }, Math.max(0, at - Date.now()));
}

async function runFlush(): Promise<void> {
  if (!isOnlineState(await NetInfo.fetch())) return;
  const due = (await allQueued()).filter(i => i.state === 'pending' && i.nextAttemptAt <= Date.now());
  for (const item of due) await uploadOne(item);
  await armRetry();
}

// Single-flight: a call while a flush runs joins it
export function flushQueue(): Promise<void> {
  if (!flushing) {
    flushing = runFlush()
      .catch(e => { if (__DEV__) console.warn('Recording queue flush failed:', e); })
      .finally(() => { flushing = null; });
  }
  return flushing;
}

export function startRecordingQueue(): () => void {
  stopped = false;
  // The app may have been killed mid-upload: those items go back to pending
  resetUploading().catch(() => 0).then(() => flushQueue());
  const unsubscribeNet = NetInfo.addEventListener(state => {
    if (isOnlineState(state)) flushQueue();
  });
  const appState = AppState.addEventListener('change', state => {
    if (state === 'active') flushQueue();
  });
  return () => {
    stopped = true;
    unsubscribeNet?.();
    appState.remove();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
}

export function __resetRecordingQueueForTests(): void {
  listeners.clear();
  flushing = null;
  stopped = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}
